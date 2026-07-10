package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"blitzcrank/internal/digest"
)

const (
	DigestDeliveryClaimed     = "claimed"
	DigestDeliverySent        = "sent"
	DigestDeliveryEmpty       = "empty"
	DigestDeliveryFailed      = "failed"
	DigestDeliveryInterrupted = "interrupted"
)

var _ digest.Repository = (*Store)(nil)

const digestSubscriptionColumns = `
id,guild_id,user_id,topics_json,release_kinds_json,cadence,schedule,weekday,time_of_day,region,timezone,locale,interests_json,enabled,next_run_at,last_run_at,last_delivered_at,created_at,updated_at,deleted_at`

// CreateDigestSubscription atomically enforces per-user identity uniqueness and
// the subscription limit. An identical non-deleted subscription is returned as
// a successful idempotent create.
func (s *Store) CreateDigestSubscription(ctx context.Context, subscription digest.Subscription) (digest.Subscription, error) {
	if subscription.ID != 0 {
		return digest.Subscription{}, errors.New("new digest subscription must not have an id")
	}
	if subscription.CreatedAt.IsZero() {
		return digest.Subscription{}, errors.New("digest subscription created time is required")
	}
	if subscription.UpdatedAt.IsZero() {
		subscription.UpdatedAt = subscription.CreatedAt
	}
	if subscription.DeletedAt != nil {
		return digest.Subscription{}, errors.New("new digest subscription cannot be deleted")
	}
	canonical, topicsJSON, releaseKindsJSON, interestsJSON, err := canonicalDigestSubscription(subscription)
	if err != nil {
		return digest.Subscription{}, err
	}
	identityKey, err := digestSubscriptionIdentity(canonical)
	if err != nil {
		return digest.Subscription{}, err
	}
	enabled := 0
	if canonical.Enabled {
		enabled = 1
	}
	result, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO digest_subscriptions(
  guild_id,user_id,identity_key,topics_json,release_kinds_json,cadence,schedule,weekday,time_of_day,region,timezone,locale,interests_json,enabled,next_run_at,last_run_at,last_delivered_at,created_at,updated_at
)
SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
WHERE (
  SELECT COUNT(*)
  FROM digest_subscriptions
  WHERE guild_id = ? AND user_id = ? AND deleted_at IS NULL
) < ?
`, canonical.Subscriber.GuildID, canonical.Subscriber.UserID, identityKey, topicsJSON, releaseKindsJSON, canonical.Cadence, canonical.Schedule, int(canonical.Weekday), canonical.TimeOfDay, canonical.Region, canonical.Timezone, canonical.Locale, interestsJSON, enabled, formatTimePtr(canonical.NextRunAt), formatTimePtr(canonical.LastRunAt), formatTimePtr(canonical.LastDeliveredAt), formatTime(canonical.CreatedAt), formatTime(canonical.UpdatedAt), canonical.Subscriber.GuildID, canonical.Subscriber.UserID, digest.MaxSubscriptionsPerUser)
	if err != nil {
		return digest.Subscription{}, err
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return digest.Subscription{}, err
	}
	if inserted == 0 {
		existing, ok, err := s.loadDigestSubscriptionByIdentity(ctx, canonical.Subscriber, identityKey)
		if err != nil {
			return digest.Subscription{}, err
		}
		if ok {
			return existing, nil
		}
		return digest.Subscription{}, fmt.Errorf("%w: at most %d digest subscriptions are allowed", digest.ErrSubscriptionLimit, digest.MaxSubscriptionsPerUser)
	}
	canonical.ID, err = result.LastInsertId()
	if err != nil {
		return digest.Subscription{}, err
	}
	return canonical, nil
}

func (s *Store) loadDigestSubscriptionByIdentity(ctx context.Context, subscriber digest.Subscriber, identityKey string) (digest.Subscription, bool, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+digestSubscriptionColumns+`
FROM digest_subscriptions
WHERE guild_id = ? AND user_id = ? AND identity_key = ? AND deleted_at IS NULL
LIMIT 1
`, subscriber.GuildID, subscriber.UserID, identityKey)
	subscription, err := scanDigestSubscription(row)
	if errors.Is(err, sql.ErrNoRows) {
		return digest.Subscription{}, false, nil
	}
	if err != nil {
		return digest.Subscription{}, false, err
	}
	return subscription, true, nil
}

// UpdateDigestSubscription changes user-editable subscription settings. The
// explicit subscriber scope prevents a Discord user from addressing another
// user's subscription by guessing its numeric ID.
func (s *Store) UpdateDigestSubscription(ctx context.Context, subscriber digest.Subscriber, subscription digest.Subscription) error {
	if subscription.ID <= 0 {
		return errors.New("digest subscription id is required")
	}
	if subscription.UpdatedAt.IsZero() {
		return errors.New("digest subscription updated time is required")
	}
	subscription.Subscriber = subscriber
	canonical, topicsJSON, releaseKindsJSON, interestsJSON, err := canonicalDigestSubscription(subscription)
	if err != nil {
		return err
	}
	identityKey, err := digestSubscriptionIdentity(canonical)
	if err != nil {
		return err
	}
	enabled := 0
	if canonical.Enabled {
		enabled = 1
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE OR IGNORE digest_subscriptions
SET identity_key = ?, topics_json = ?, release_kinds_json = ?, cadence = ?, schedule = ?, weekday = ?, time_of_day = ?, region = ?, timezone = ?, locale = ?, interests_json = ?, enabled = ?, next_run_at = ?, updated_at = ?
WHERE id = ? AND guild_id = ? AND user_id = ? AND deleted_at IS NULL
`, identityKey, topicsJSON, releaseKindsJSON, canonical.Cadence, canonical.Schedule, int(canonical.Weekday), canonical.TimeOfDay, canonical.Region, canonical.Timezone, canonical.Locale, interestsJSON, enabled, formatTimePtr(canonical.NextRunAt), formatTime(canonical.UpdatedAt), canonical.ID, canonical.Subscriber.GuildID, canonical.Subscriber.UserID)
	if err != nil {
		return err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if updated == 1 {
		return nil
	}
	var targetID int64
	err = s.db.QueryRowContext(ctx, `
SELECT id
FROM digest_subscriptions
WHERE id = ? AND guild_id = ? AND user_id = ? AND deleted_at IS NULL
`, canonical.ID, canonical.Subscriber.GuildID, canonical.Subscriber.UserID).Scan(&targetID)
	if errors.Is(err, sql.ErrNoRows) {
		return requireUpdatedRow(result, "digest subscription", strconv.FormatInt(canonical.ID, 10))
	}
	if err != nil {
		return err
	}
	return digest.ErrSubscriptionAlreadyExists
}

func (s *Store) LoadDigestSubscription(ctx context.Context, subscriber digest.Subscriber, subscriptionID int64) (digest.Subscription, bool, error) {
	canonicalSubscriber, err := canonicalDigestSubscriber(subscriber)
	if err != nil {
		return digest.Subscription{}, false, err
	}
	row := s.db.QueryRowContext(ctx, `SELECT `+digestSubscriptionColumns+`
FROM digest_subscriptions
WHERE id = ? AND guild_id = ? AND user_id = ? AND deleted_at IS NULL
`, subscriptionID, canonicalSubscriber.GuildID, canonicalSubscriber.UserID)
	subscription, err := scanDigestSubscription(row)
	if errors.Is(err, sql.ErrNoRows) {
		return digest.Subscription{}, false, nil
	}
	if err != nil {
		return digest.Subscription{}, false, err
	}
	return subscription, true, nil
}

func (s *Store) ListDigestSubscriptions(ctx context.Context, subscriber digest.Subscriber) ([]digest.Subscription, error) {
	canonicalSubscriber, err := canonicalDigestSubscriber(subscriber)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+digestSubscriptionColumns+`
FROM digest_subscriptions
WHERE guild_id = ? AND user_id = ? AND deleted_at IS NULL
ORDER BY created_at, id
`, canonicalSubscriber.GuildID, canonicalSubscriber.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subscriptions []digest.Subscription
	for rows.Next() {
		subscription, err := scanDigestSubscription(rows)
		if err != nil {
			return nil, err
		}
		subscriptions = append(subscriptions, subscription)
	}
	return subscriptions, rows.Err()
}

func (s *Store) SetDigestSubscriptionEnabled(ctx context.Context, subscriber digest.Subscriber, subscriptionID int64, enabled bool, nextRunAt *time.Time, updatedAt time.Time) error {
	canonicalSubscriber, err := canonicalDigestSubscriber(subscriber)
	if err != nil {
		return err
	}
	if subscriptionID <= 0 {
		return errors.New("digest subscription id is required")
	}
	if updatedAt.IsZero() {
		return errors.New("digest subscription updated time is required")
	}
	if enabled && (nextRunAt == nil || nextRunAt.IsZero()) {
		return errors.New("enabled digest subscription requires a next run time")
	}
	if !enabled {
		nextRunAt = nil
	}
	enabledValue := 0
	if enabled {
		enabledValue = 1
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE digest_subscriptions
SET enabled = ?, next_run_at = ?, updated_at = ?
WHERE id = ? AND guild_id = ? AND user_id = ? AND deleted_at IS NULL
`, enabledValue, formatTimePtr(nextRunAt), formatTime(updatedAt), subscriptionID, canonicalSubscriber.GuildID, canonicalSubscriber.UserID)
	if err != nil {
		return err
	}
	return requireUpdatedRow(result, "digest subscription", strconv.FormatInt(subscriptionID, 10))
}

func (s *Store) DeleteDigestSubscription(ctx context.Context, subscriber digest.Subscriber, subscriptionID int64, deletedAt time.Time) error {
	canonicalSubscriber, err := canonicalDigestSubscriber(subscriber)
	if err != nil {
		return err
	}
	if subscriptionID <= 0 {
		return errors.New("digest subscription id is required")
	}
	if deletedAt.IsZero() {
		return errors.New("digest subscription deleted time is required")
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE digest_subscriptions
SET enabled = 0, next_run_at = NULL, updated_at = ?, deleted_at = ?
WHERE id = ? AND guild_id = ? AND user_id = ? AND deleted_at IS NULL
`, formatTime(deletedAt), formatTime(deletedAt), subscriptionID, canonicalSubscriber.GuildID, canonicalSubscriber.UserID)
	if err != nil {
		return err
	}
	return requireUpdatedRow(result, "digest subscription", strconv.FormatInt(subscriptionID, 10))
}

func (s *Store) ListDueDigestSubscriptions(ctx context.Context, at time.Time, limit int) ([]digest.Subscription, error) {
	if at.IsZero() {
		return nil, errors.New("digest due time is required")
	}
	if limit <= 0 {
		return nil, errors.New("digest due limit must be positive")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+digestSubscriptionColumns+`
FROM digest_subscriptions
WHERE enabled = 1
  AND deleted_at IS NULL
  AND next_run_at IS NOT NULL
  AND julianday(next_run_at) <= julianday(?)
ORDER BY next_run_at, id
LIMIT ?
`, formatTime(at), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subscriptions []digest.Subscription
	for rows.Next() {
		subscription, err := scanDigestSubscription(rows)
		if err != nil {
			return nil, err
		}
		subscriptions = append(subscriptions, subscription)
	}
	return subscriptions, rows.Err()
}

// ClaimDigestDelivery atomically advances a still-current subscription and
// inserts its delivery record. It returns claimed=false when the subscription
// was disabled, deleted, rescheduled, already claimed, or is not due yet.
func (s *Store) ClaimDigestDelivery(ctx context.Context, claim digest.DeliveryClaim) (digest.Delivery, bool, error) {
	if err := validateDigestDeliveryClaim(claim); err != nil {
		return digest.Delivery{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return digest.Delivery{}, false, err
	}
	defer tx.Rollback()

	result, err := tx.ExecContext(ctx, `
UPDATE digest_subscriptions
SET next_run_at = ?, last_run_at = ?, updated_at = ?
WHERE id = ?
  AND enabled = 1
  AND deleted_at IS NULL
  AND next_run_at = ?
  AND julianday(next_run_at) <= julianday(?)
`, formatTime(claim.NextRunAt), formatTime(claim.StartedAt), formatTime(claim.StartedAt), claim.SubscriptionID, formatTime(claim.ScheduledFor), formatTime(claim.StartedAt))
	if err != nil {
		return digest.Delivery{}, false, err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return digest.Delivery{}, false, err
	}
	if updated == 0 {
		return digest.Delivery{}, false, nil
	}
	result, err = tx.ExecContext(ctx, `
INSERT INTO digest_deliveries(subscription_id,scheduled_for,window_start,window_end,claimed_next_run_at,status,started_at)
VALUES(?,?,?,?,?,?,?)
`, claim.SubscriptionID, formatTime(claim.ScheduledFor), formatTime(claim.WindowStart), formatTime(claim.WindowEnd), formatTime(claim.NextRunAt), DigestDeliveryClaimed, formatTime(claim.StartedAt))
	if err != nil {
		return digest.Delivery{}, false, err
	}
	deliveryID, err := result.LastInsertId()
	if err != nil {
		return digest.Delivery{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return digest.Delivery{}, false, err
	}
	return digest.Delivery{
		ID:             deliveryID,
		SubscriptionID: claim.SubscriptionID,
		ScheduledFor:   claim.ScheduledFor,
		WindowStart:    claim.WindowStart,
		WindowEnd:      claim.WindowEnd,
		Status:         DigestDeliveryClaimed,
		StartedAt:      claim.StartedAt,
	}, true, nil
}

// ReserveDigestDeliveryItems durably claims release-key hashes before the
// Discord side effect. Reservations, including those from an interrupted send,
// count as seen so a restart cannot produce duplicate notifications without
// retaining provider media identifiers in plaintext.
func (s *Store) ReserveDigestDeliveryItems(ctx context.Context, deliveryID int64, itemKeys []string, reservedAt time.Time) ([]string, error) {
	if deliveryID <= 0 {
		return nil, errors.New("digest delivery id is required")
	}
	if reservedAt.IsZero() {
		return nil, errors.New("digest item reservation time is required")
	}
	keys, err := canonicalDigestItemKeys(itemKeys)
	if err != nil {
		return nil, err
	}
	if len(keys) == 0 {
		return nil, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var subscriptionID int64
	err = tx.QueryRowContext(ctx, `
SELECT subscription_id
FROM digest_deliveries
WHERE id = ? AND status = ? AND completed_at IS NULL
`, deliveryID, DigestDeliveryClaimed).Scan(&subscriptionID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("digest delivery %q is not claimable", strconv.FormatInt(deliveryID, 10))
	}
	if err != nil {
		return nil, err
	}

	reserved := make([]string, 0, len(keys))
	for _, key := range keys {
		storedKey := digestItemStorageKey(key)
		result, err := tx.ExecContext(ctx, `
INSERT INTO digest_delivery_items(subscription_id,item_key,first_delivery_id,reserved_at)
VALUES(?,?,?,?)
ON CONFLICT(subscription_id,item_key) DO NOTHING
	`, subscriptionID, storedKey, deliveryID, formatTime(reservedAt))
		if err != nil {
			return nil, err
		}
		inserted, err := result.RowsAffected()
		if err != nil {
			return nil, err
		}
		if inserted == 1 {
			reserved = append(reserved, key)
		}
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE digest_deliveries
SET item_count = (SELECT COUNT(*) FROM digest_delivery_items WHERE first_delivery_id = ?)
WHERE id = ?
`, deliveryID, deliveryID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return reserved, nil
}

func (s *Store) CompleteDigestDelivery(ctx context.Context, deliveryID int64, status, discordChannelID, discordMessageID, sanitizedError string, completedAt time.Time, retryAt *time.Time) error {
	if deliveryID <= 0 {
		return errors.New("digest delivery id is required")
	}
	if !terminalDigestDeliveryStatus(status) {
		return fmt.Errorf("invalid terminal digest delivery status %q", status)
	}
	if completedAt.IsZero() {
		return errors.New("digest delivery completion time is required")
	}
	if retryAt != nil && (retryAt.IsZero() || !retryAt.After(completedAt)) {
		return errors.New("digest delivery retry time must be after completion")
	}
	if retryAt != nil && status != DigestDeliveryFailed {
		return errors.New("only a failed digest delivery can be retried")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var subscriptionID int64
	var claimedNextRunAt string
	err = tx.QueryRowContext(ctx, `
SELECT subscription_id, claimed_next_run_at
FROM digest_deliveries
WHERE id = ? AND status = ? AND completed_at IS NULL
`, deliveryID, DigestDeliveryClaimed).Scan(&subscriptionID, &claimedNextRunAt)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("digest delivery %q is not active", strconv.FormatInt(deliveryID, 10))
	}
	if err != nil {
		return err
	}
	var itemCount int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM digest_delivery_items WHERE first_delivery_id = ?`, deliveryID).Scan(&itemCount); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE digest_deliveries
SET status = ?, completed_at = ?, discord_channel_id = ?, discord_message_id = ?, item_count = ?, error = ?
WHERE id = ? AND status = ? AND completed_at IS NULL
`, status, formatTime(completedAt), strings.TrimSpace(discordChannelID), strings.TrimSpace(discordMessageID), itemCount, storedSanitizedError(sanitizedError), deliveryID, DigestDeliveryClaimed)
	if err != nil {
		return err
	}
	if err := requireUpdatedRow(result, "digest delivery", strconv.FormatInt(deliveryID, 10)); err != nil {
		return err
	}
	if status == DigestDeliverySent {
		if _, err := tx.ExecContext(ctx, `UPDATE digest_delivery_items SET delivered_at = ? WHERE first_delivery_id = ?`, formatTime(completedAt), deliveryID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE digest_subscriptions SET last_delivered_at = ?, updated_at = ? WHERE id = ?`, formatTime(completedAt), formatTime(completedAt), subscriptionID); err != nil {
			return err
		}
	}
	if retryAt != nil {
		// An explicit retry means the caller knows no Discord message was accepted.
		// Release this attempt's reservations so the retry can render the same
		// items. Ambiguous crashes use MarkInterruptedDigestDeliveries instead and
		// deliberately retain their reservations.
		if _, err := tx.ExecContext(ctx, `DELETE FROM digest_delivery_items WHERE first_delivery_id = ? AND delivered_at IS NULL`, deliveryID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE digest_subscriptions
SET next_run_at = ?, updated_at = ?
WHERE id = ? AND enabled = 1 AND deleted_at IS NULL AND next_run_at = ?
`, formatTime(*retryAt), formatTime(completedAt), subscriptionID, claimedNextRunAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AbandonDigestDelivery finalizes a claim that is known not to have reached
// Discord, releases its item reservations, and leaves the subscription's
// current schedule untouched. It is used when the subscriber edits, pauses, or
// deletes the subscription while recommendations are being built.
func (s *Store) AbandonDigestDelivery(ctx context.Context, deliveryID int64, sanitizedError string, completedAt time.Time) error {
	if deliveryID <= 0 {
		return errors.New("digest delivery id is required")
	}
	if completedAt.IsZero() {
		return errors.New("digest delivery completion time is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var activeID int64
	if err := tx.QueryRowContext(ctx, `
SELECT id FROM digest_deliveries
WHERE id = ? AND status = ? AND completed_at IS NULL
`, deliveryID, DigestDeliveryClaimed).Scan(&activeID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("digest delivery %q is not active", strconv.FormatInt(deliveryID, 10))
		}
		return err
	}
	var itemCount int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM digest_delivery_items WHERE first_delivery_id = ?`, deliveryID).Scan(&itemCount); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM digest_delivery_items WHERE first_delivery_id = ? AND delivered_at IS NULL`, deliveryID); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE digest_deliveries
SET status = ?, completed_at = ?, item_count = ?, error = ?
WHERE id = ? AND status = ? AND completed_at IS NULL
`, DigestDeliveryInterrupted, formatTime(completedAt), itemCount, storedSanitizedError(sanitizedError), activeID, DigestDeliveryClaimed)
	if err != nil {
		return err
	}
	if err := requireUpdatedRow(result, "digest delivery", strconv.FormatInt(deliveryID, 10)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) MarkInterruptedDigestDeliveries(ctx context.Context, sanitizedError string, at time.Time) error {
	if at.IsZero() {
		return errors.New("digest interruption time is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `
SELECT subscription_id, claimed_next_run_at
FROM digest_deliveries
WHERE status = ? AND completed_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM digest_delivery_items
    WHERE first_delivery_id = digest_deliveries.id
  )
`, DigestDeliveryClaimed)
	if err != nil {
		return err
	}
	type retryableClaim struct {
		subscriptionID   int64
		claimedNextRunAt string
	}
	var retryable []retryableClaim
	for rows.Next() {
		var claim retryableClaim
		if err := rows.Scan(&claim.subscriptionID, &claim.claimedNextRunAt); err != nil {
			_ = rows.Close()
			return err
		}
		retryable = append(retryable, claim)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, claim := range retryable {
		if _, err := tx.ExecContext(ctx, `
UPDATE digest_subscriptions
SET next_run_at = ?, updated_at = ?
WHERE id = ? AND enabled = 1 AND deleted_at IS NULL AND next_run_at = ?
`, formatTime(at), formatTime(at), claim.subscriptionID, claim.claimedNextRunAt); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE digest_deliveries
SET status = ?, completed_at = ?, error = ?,
    item_count = (SELECT COUNT(*) FROM digest_delivery_items WHERE first_delivery_id = digest_deliveries.id)
WHERE status = ? AND completed_at IS NULL
`, DigestDeliveryInterrupted, formatTime(at), storedSanitizedError(sanitizedError), DigestDeliveryClaimed); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) LoadDigestDelivery(ctx context.Context, deliveryID int64) (digest.Delivery, bool, error) {
	var delivery digest.Delivery
	var completedAt, channelID, messageID sql.NullString
	err := s.db.QueryRowContext(ctx, `
SELECT id,subscription_id,scheduled_for,window_start,window_end,status,started_at,completed_at,discord_channel_id,discord_message_id,item_count,error
FROM digest_deliveries
WHERE id = ?
`, deliveryID).Scan(&delivery.ID, &delivery.SubscriptionID, scanTime(&delivery.ScheduledFor), scanTime(&delivery.WindowStart), scanTime(&delivery.WindowEnd), &delivery.Status, scanTime(&delivery.StartedAt), &completedAt, &channelID, &messageID, &delivery.ItemCount, &delivery.Error)
	if errors.Is(err, sql.ErrNoRows) {
		return digest.Delivery{}, false, nil
	}
	if err != nil {
		return digest.Delivery{}, false, err
	}
	delivery.CompletedAt, err = parseNullTime(completedAt)
	if err != nil {
		return digest.Delivery{}, false, err
	}
	delivery.DiscordChannelID = channelID.String
	delivery.DiscordMessageID = messageID.String
	return delivery, true, nil
}

type digestSubscriptionScanner interface {
	Scan(...any) error
}

func scanDigestSubscription(scanner digestSubscriptionScanner) (digest.Subscription, error) {
	var subscription digest.Subscription
	var topicsJSON, releaseKindsJSON, interestsJSON string
	var enabled, weekday int
	var nextRunAt, lastRunAt, lastDeliveredAt, deletedAt sql.NullString
	err := scanner.Scan(
		&subscription.ID,
		&subscription.Subscriber.GuildID,
		&subscription.Subscriber.UserID,
		&topicsJSON,
		&releaseKindsJSON,
		&subscription.Cadence,
		&subscription.Schedule,
		&weekday,
		&subscription.TimeOfDay,
		&subscription.Region,
		&subscription.Timezone,
		&subscription.Locale,
		&interestsJSON,
		&enabled,
		&nextRunAt,
		&lastRunAt,
		&lastDeliveredAt,
		scanTime(&subscription.CreatedAt),
		scanTime(&subscription.UpdatedAt),
		&deletedAt,
	)
	if err != nil {
		return digest.Subscription{}, err
	}
	subscription.Weekday = time.Weekday(weekday)
	subscription.Enabled = enabled == 1
	if err := json.Unmarshal([]byte(topicsJSON), &subscription.Topics); err != nil {
		return digest.Subscription{}, fmt.Errorf("decode digest topics: %w", err)
	}
	if err := json.Unmarshal([]byte(releaseKindsJSON), &subscription.ReleaseKinds); err != nil {
		return digest.Subscription{}, fmt.Errorf("decode digest release kinds: %w", err)
	}
	if err := json.Unmarshal([]byte(interestsJSON), &subscription.Interests); err != nil {
		return digest.Subscription{}, fmt.Errorf("decode digest interests: %w", err)
	}
	subscription.NextRunAt, err = parseNullTime(nextRunAt)
	if err != nil {
		return digest.Subscription{}, err
	}
	subscription.LastRunAt, err = parseNullTime(lastRunAt)
	if err != nil {
		return digest.Subscription{}, err
	}
	subscription.LastDeliveredAt, err = parseNullTime(lastDeliveredAt)
	if err != nil {
		return digest.Subscription{}, err
	}
	subscription.DeletedAt, err = parseNullTime(deletedAt)
	if err != nil {
		return digest.Subscription{}, err
	}
	return subscription, nil
}

func canonicalDigestSubscription(subscription digest.Subscription) (digest.Subscription, string, string, string, error) {
	subscriber, err := canonicalDigestSubscriber(subscription.Subscriber)
	if err != nil {
		return digest.Subscription{}, "", "", "", err
	}
	subscription.Subscriber = subscriber
	subscription.Schedule = strings.TrimSpace(subscription.Schedule)
	subscription.TimeOfDay = strings.TrimSpace(subscription.TimeOfDay)
	subscription.Region = strings.ToUpper(strings.TrimSpace(subscription.Region))
	subscription.Timezone = strings.TrimSpace(subscription.Timezone)
	subscription.Locale = strings.ReplaceAll(strings.TrimSpace(subscription.Locale), "_", "-")
	if subscription.Schedule == "" {
		return digest.Subscription{}, "", "", "", errors.New("digest schedule is required")
	}
	if subscription.Weekday < time.Sunday || subscription.Weekday > time.Saturday {
		return digest.Subscription{}, "", "", "", fmt.Errorf("invalid digest weekday %d", subscription.Weekday)
	}
	if _, err := time.Parse("15:04", subscription.TimeOfDay); err != nil {
		return digest.Subscription{}, "", "", "", fmt.Errorf("invalid digest time of day %q: %w", subscription.TimeOfDay, err)
	}
	if subscription.Timezone == "" {
		return digest.Subscription{}, "", "", "", errors.New("digest timezone is required")
	}
	if _, err := time.LoadLocation(subscription.Timezone); err != nil {
		return digest.Subscription{}, "", "", "", fmt.Errorf("invalid digest timezone %q: %w", subscription.Timezone, err)
	}
	if subscription.Locale == "" {
		return digest.Subscription{}, "", "", "", errors.New("digest locale is required")
	}
	switch subscription.Cadence {
	case digest.CadenceDaily, digest.CadenceWeekly, digest.CadenceSeasonal:
	default:
		return digest.Subscription{}, "", "", "", fmt.Errorf("invalid digest cadence %q", subscription.Cadence)
	}
	topics, err := canonicalDigestTopics(subscription.Topics)
	if err != nil {
		return digest.Subscription{}, "", "", "", err
	}
	releaseKinds, err := canonicalDigestReleaseKinds(subscription.ReleaseKinds)
	if err != nil {
		return digest.Subscription{}, "", "", "", err
	}
	interests := canonicalDigestInterests(subscription.Interests)
	if subscription.Enabled && (subscription.NextRunAt == nil || subscription.NextRunAt.IsZero()) {
		return digest.Subscription{}, "", "", "", errors.New("enabled digest subscription requires a next run time")
	}
	if !subscription.Enabled {
		subscription.NextRunAt = nil
	}
	subscription.Topics = topics
	subscription.ReleaseKinds = releaseKinds
	subscription.Interests = interests
	topicsJSON, err := json.Marshal(topics)
	if err != nil {
		return digest.Subscription{}, "", "", "", fmt.Errorf("encode digest topics: %w", err)
	}
	releaseKindsJSON, err := json.Marshal(releaseKinds)
	if err != nil {
		return digest.Subscription{}, "", "", "", fmt.Errorf("encode digest release kinds: %w", err)
	}
	interestsJSON, err := json.Marshal(interests)
	if err != nil {
		return digest.Subscription{}, "", "", "", fmt.Errorf("encode digest interests: %w", err)
	}
	return subscription, string(topicsJSON), string(releaseKindsJSON), string(interestsJSON), nil
}

func canonicalDigestSubscriber(subscriber digest.Subscriber) (digest.Subscriber, error) {
	subscriber.GuildID = strings.TrimSpace(subscriber.GuildID)
	subscriber.UserID = strings.TrimSpace(subscriber.UserID)
	if subscriber.GuildID == "" {
		return digest.Subscriber{}, errors.New("digest subscriber guild id is required")
	}
	if subscriber.UserID == "" {
		return digest.Subscriber{}, errors.New("digest subscriber user id is required")
	}
	return subscriber, nil
}

func canonicalDigestTopics(values []digest.Topic) ([]digest.Topic, error) {
	seen := make(map[digest.Topic]struct{}, len(values))
	for _, value := range values {
		switch value {
		case digest.TopicAnimeSeasons, digest.TopicShowPremieres, digest.TopicMovieReleases:
			seen[value] = struct{}{}
		default:
			return nil, fmt.Errorf("invalid digest topic %q", value)
		}
	}
	if len(seen) == 0 {
		return nil, errors.New("digest subscription requires at least one topic")
	}
	out := make([]digest.Topic, 0, len(seen))
	for value := range seen {
		out = append(out, value)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

func canonicalDigestReleaseKinds(values []digest.ReleaseKind) ([]digest.ReleaseKind, error) {
	seen := make(map[digest.ReleaseKind]struct{}, len(values))
	for _, value := range values {
		switch value {
		case digest.ReleaseKindOnline, digest.ReleaseKindPhysical, digest.ReleaseKindCinema:
			seen[value] = struct{}{}
		default:
			return nil, fmt.Errorf("invalid digest release kind %q", value)
		}
	}
	if len(seen) == 0 {
		return nil, errors.New("digest subscription requires at least one release kind")
	}
	out := make([]digest.ReleaseKind, 0, len(seen))
	for value := range seen {
		out = append(out, value)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

func canonicalDigestInterests(values []string) []string {
	seen := make(map[string]string, len(values))
	for _, value := range values {
		value = strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, ok := seen[key]; !ok {
			seen[key] = value
		}
	}
	keys := make([]string, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, seen[key])
	}
	return out
}

func digestSubscriptionIdentity(subscription digest.Subscription) (string, error) {
	interests := make([]string, 0, len(subscription.Interests))
	for _, interest := range subscription.Interests {
		interests = append(interests, strings.ToLower(strings.Join(strings.Fields(interest), " ")))
	}
	sort.Strings(interests)
	identity := struct {
		Topics       []digest.Topic
		ReleaseKinds []digest.ReleaseKind
		Cadence      digest.Cadence
		Schedule     string
		Weekday      time.Weekday
		TimeOfDay    string
		Region       string
		Timezone     string
		Locale       string
		Interests    []string
	}{
		Topics:       subscription.Topics,
		ReleaseKinds: subscription.ReleaseKinds,
		Cadence:      subscription.Cadence,
		Schedule:     subscription.Schedule,
		Weekday:      subscription.Weekday,
		TimeOfDay:    subscription.TimeOfDay,
		Region:       subscription.Region,
		Timezone:     subscription.Timezone,
		Locale:       subscription.Locale,
		Interests:    interests,
	}
	encoded, err := json.Marshal(identity)
	if err != nil {
		return "", fmt.Errorf("encode digest subscription identity: %w", err)
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func (s *Store) migrateDigestSubscriptionIdentities(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin digest subscription identity migration: %w", err)
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(ctx, `SELECT `+digestSubscriptionColumns+`
FROM digest_subscriptions
WHERE identity_key = '' OR identity_key IS NULL
ORDER BY id
`)
	if err != nil {
		return fmt.Errorf("load digest subscriptions for identity migration: %w", err)
	}
	var subscriptions []digest.Subscription
	for rows.Next() {
		subscription, err := scanDigestSubscription(rows)
		if err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan digest subscription for identity migration: %w", err)
		}
		subscriptions = append(subscriptions, subscription)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("load digest subscriptions for identity migration: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close digest subscription identity rows: %w", err)
	}

	for _, subscription := range subscriptions {
		canonical, _, _, _, err := canonicalDigestSubscription(subscription)
		if err != nil {
			return fmt.Errorf("canonicalize digest subscription %d for identity migration: %w", subscription.ID, err)
		}
		identityKey, err := digestSubscriptionIdentity(canonical)
		if err != nil {
			return fmt.Errorf("build digest subscription %d identity: %w", subscription.ID, err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE digest_subscriptions SET identity_key = ? WHERE id = ?`, identityKey, subscription.ID); err != nil {
			return fmt.Errorf("update digest subscription %d identity: %w", subscription.ID, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE digest_subscriptions
SET enabled = 0, next_run_at = NULL, deleted_at = updated_at
WHERE deleted_at IS NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM digest_subscriptions
    WHERE deleted_at IS NULL
    GROUP BY guild_id, user_id, identity_key
  )
`); err != nil {
		return fmt.Errorf("deduplicate digest subscriptions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_subscriptions_identity
ON digest_subscriptions(guild_id, user_id, identity_key)
WHERE deleted_at IS NULL
`); err != nil {
		return fmt.Errorf("create digest subscription identity index: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit digest subscription identity migration: %w", err)
	}
	return nil
}

func canonicalDigestItemKeys(values []string) ([]string, error) {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if len(value) > 512 {
			return nil, errors.New("digest item key exceeds 512 bytes")
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out, nil
}

func digestItemStorageKey(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func validateDigestDeliveryClaim(claim digest.DeliveryClaim) error {
	if claim.SubscriptionID <= 0 {
		return errors.New("digest delivery subscription id is required")
	}
	if claim.ScheduledFor.IsZero() || claim.NextRunAt.IsZero() || claim.WindowStart.IsZero() || claim.WindowEnd.IsZero() || claim.StartedAt.IsZero() {
		return errors.New("digest delivery claim times are required")
	}
	if !claim.NextRunAt.After(claim.ScheduledFor) {
		return errors.New("digest next run must be after the claimed run")
	}
	if !claim.WindowEnd.After(claim.WindowStart) {
		return errors.New("digest delivery window end must be after its start")
	}
	return nil
}

func terminalDigestDeliveryStatus(status string) bool {
	switch status {
	case DigestDeliverySent, DigestDeliveryEmpty, DigestDeliveryFailed, DigestDeliveryInterrupted:
		return true
	default:
		return false
	}
}
