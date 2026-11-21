import {
  isNumber,
  isString,
  numberList,
  objectField,
  objectList,
  type JsonObject,
} from "../../json.ts"
import type { Resolved, WriteEffect } from "../../tools/writes.ts"
import type { CatalogRef } from "./client.ts"
import { titleLabel } from "./compact.ts"

export interface ShowScope {
  seasons: number[]
  future: boolean
}

/** What an ask sends, fixed when it is previewed. */
export interface AskPlan {
  ref: CatalogRef
  libraryId: string
  scope: ShowScope | undefined
}

export interface AskInput {
  ref: CatalogRef
  seasons?: number[] | undefined
  future?: boolean | undefined
}

const OPEN = new Set(["ask", "add"])
const REQUESTED = new Set(["asked", "coming", "release"])

/** Why Matinee offers the request account no request, in its own terms. */
function refusal(availability: JsonObject | undefined, what: string): string {
  const reason = availability?.disabledReason
  const limit = objectField(availability, "limit")
  if (reason === "declined") {
    return `an admin declined ${what}; nobody can request it until an admin allows it again`
  }
  if (reason === "off") {
    return `the request account's group may not request ${what}`
  }
  if (reason === "limit") {
    return `the request account has used its request quota; it frees up at ${String(limit?.resetsAt ?? "an unknown time")}`
  }
  if (reason === "noDestination") {
    return `no library takes requests for ${what} from the request account`
  }
  const state = String(availability?.state ?? "unknown")
  if (state === "here") return `${what} is here already`
  if (REQUESTED.has(state)) {
    return `${what} is requested already (${state}, request ${String(availability?.requestId ?? "unknown")})`
  }
  return `Matinee offers no request for ${what} (state ${state})`
}

function seasonEntries(detail: JsonObject) {
  return objectList(detail.seasons).flatMap((season) =>
    isNumber(season.number)
      ? [
          {
            number: season.number,
            availability: objectField(season, "availability"),
          },
        ]
      : [],
  )
}

/**
 * The scope an ask for a show sends: the seasons named, or Matinee's default
 * of every aired season and the ones to come.
 */
function scopeOf(detail: JsonObject, input: AskInput): ShowScope {
  const fallback = objectField(detail, "defaultScope")
  if (input.seasons !== undefined) {
    return {
      seasons: [...new Set(input.seasons)],
      future: input.future ?? false,
    }
  }
  return {
    seasons: numberList(fallback?.seasons),
    future: input.future ?? fallback?.future === true,
  }
}

function planShow(
  detail: JsonObject,
  input: AskInput,
  label: string,
): { scope: ShowScope; approval: string; coverage: string[] } {
  const scope = scopeOf(detail, input)
  const seasons = seasonEntries(detail)
  const listed = new Set(seasons.map((season) => season.number))
  const unknown = scope.seasons.filter((number) => !listed.has(number))
  if (unknown.length > 0) {
    throw new Error(
      `Matinee lists no season ${unknown.join(", ")} for ${label}; it lists ${[...listed].join(", ") || "none"}. Nothing was written`,
    )
  }
  const asked = seasons.filter((season) =>
    scope.seasons.includes(season.number),
  )
  // Matinee's default scope is every aired season, those here included, and
  // it takes them as they are: only seasons the person named are held to
  // being requestable.
  const named = input.seasons !== undefined
  const here = asked.filter((season) => season.availability?.state === "here")
  if (named && here.length > 0) {
    throw new Error(
      `season ${here.map((season) => season.number).join(", ")} of ${label} is here already; leave it out. Nothing was written`,
    )
  }
  const blocked = asked.find(
    (season) =>
      season.availability?.state !== "here" &&
      !OPEN.has(String(season.availability?.action)) &&
      !REQUESTED.has(String(season.availability?.state)),
  )
  if (named && blocked) {
    throw new Error(
      `${refusal(blocked.availability, `season ${blocked.number} of ${label}`)}. Nothing was written`,
    )
  }
  const open = asked.filter((season) =>
    OPEN.has(String(season.availability?.action)),
  )
  if (open.length === 0 && !scope.future) {
    throw new Error(
      `every season asked for of ${label} is requested already. Nothing was written`,
    )
  }
  const coverage = seasons.flatMap((season) => {
    const state = String(season.availability?.state ?? "unknown")
    if (state === "none") return []
    const counts = `${String(season.availability?.episodesHere ?? "?")} of ${String(season.availability?.episodesAired ?? "?")} aired episodes here`
    return [`season ${season.number}: ${state}, ${counts}`]
  })
  const adds = open.some((season) => season.availability?.action === "add")
  return {
    scope,
    approval:
      open.length === 0
        ? "adds only the seasons still to come, if the request does not cover them already"
        : adds
          ? "approved at once: Matinee sends it to the library's download manager"
          : "waits for an admin's approval",
    coverage,
  }
}

/**
 * Checks an ask against what Matinee offers the request account, before
 * anything is sent: the destination library, the seasons, and what a
 * request already covers. Throws when Matinee would refuse, or the ask
 * would add nothing.
 */
export function planAsk(
  detail: JsonObject,
  input: AskInput,
): Resolved<AskPlan> {
  const label = `${titleLabel(detail)}, ${input.ref.kind} ${input.ref.provider} ${input.ref.providerId}`
  const availability = objectField(detail, "availability")
  if (availability?.disabledReason === "declined") {
    throw new Error(`${refusal(availability, label)}. Nothing was written`)
  }
  const destination = objectList(detail.destinations).find(
    (entry) => entry.selected === true,
  )
  if (!destination || !isString(destination.id)) {
    throw new Error(
      `no library takes requests for ${label} from the request account. Nothing was written`,
    )
  }
  const limit = objectField(availability, "limit")
  const others = objectField(availability, "others")
  const warnings = [
    "the library's Matinee connection picks the download manager, quality profile, and folder",
    ...(limit
      ? [
          `the request account has ${String(limit.left)} requests left until ${String(limit.resetsAt)}`,
        ]
      : []),
  ]
  if (input.ref.kind === "movie") {
    if (input.seasons !== undefined || input.future !== undefined) {
      throw new Error("seasons and future are for shows only")
    }
    if (!OPEN.has(String(availability?.action))) {
      throw new Error(`${refusal(availability, label)}. Nothing was written`)
    }
    return {
      state: { ref: input.ref, libraryId: destination.id, scope: undefined },
      summary: `Request ${label} into ${String(destination.name)}`,
      effects: [
        {
          kind: "request",
          target: label,
          detail: [
            `into library ${String(destination.name)}`,
            availability?.action === "add"
              ? "approved at once: Matinee sends it to the library's download manager"
              : "waits for an admin's approval",
          ].join("; "),
        },
      ],
      warnings,
    }
  }
  const show = planShow(detail, input, label)
  const effect: WriteEffect = {
    kind: "request",
    target: label,
    detail: [
      `into library ${String(destination.name)}`,
      `seasons ${show.scope.seasons.join(", ") || "none"}${show.scope.future ? ", and new seasons as they air" : ""}`,
      show.approval,
    ].join("; "),
  }
  const existing: WriteEffect[] =
    show.coverage.length > 0 || isString(availability?.requestId)
      ? [
          {
            kind: "already",
            target: label,
            detail: [
              ...(isString(availability?.requestId)
                ? [
                    `request ${availability.requestId} exists, ${String(others?.count ?? 0)} other accounts asking`,
                  ]
                : []),
              ...show.coverage,
            ].join("; "),
          },
        ]
      : []
  return {
    state: {
      ref: input.ref,
      libraryId: destination.id,
      scope: show.scope,
    },
    summary: `Request ${label} into ${String(destination.name)}`,
    effects: [effect, ...existing],
    warnings,
  }
}
