{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.blitzcrank;
  stateDir = "/var/lib/blitzcrank";

  # Seeds {option}`authFile` from a read-only secret (sops, agenix, ...) that
  # systemd exposes as a credential. The live file must stay writable — pi
  # refreshes OAuth tokens in place — so the secret is copied, not linked, and
  # only when its content differs from the last seeded content (recorded next
  # to it). Rebuilds therefore never clobber refreshed tokens, while rotating
  # the secret does take effect on the next start.
  seedAuthFile = pkgs.writeShellScript "blitzcrank-seed-auth" ''
    set -eu
    seed="$CREDENTIALS_DIRECTORY/auth-seed"
    stamp="${cfg.authFile}.seed-sha256"
    sum="$(${pkgs.coreutils}/bin/sha256sum "$seed" | ${pkgs.coreutils}/bin/cut -d' ' -f1)"
    if [ -s "${cfg.authFile}" ] && [ "$(${pkgs.coreutils}/bin/cat "$stamp" 2>/dev/null || true)" = "$sum" ]; then
      exit 0
    fi
    ${pkgs.coreutils}/bin/install -m 600 "$seed" "${cfg.authFile}"
    printf '%s\n' "$sum" > "$stamp"
  '';
in
{
  options.services.blitzcrank = {
    enable = lib.mkEnableOption "blitzcrank, the agentic Seerr issue gateway";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The blitzcrank package to run.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8484;
      description = "Listen port for the webhook/API server.";
    };

    model = lib.mkOption {
      type = lib.types.str;
      default = "anthropic/claude-sonnet-4-5";
      example = "openai-codex/gpt-5.2-codex";
      description = ''
        Model as provider/model. API-key providers (anthropic, openai, ...)
        authenticate via environment variables from {option}`environmentFile`.
        OAuth providers (openai-codex, ...) authenticate via the auth file,
        see {option}`authFile`.
      '';
    };

    language = lib.mkOption {
      type = lib.types.str;
      default = "German";
      description = "Language for public comments and operations notes.";
    };

    authFile = lib.mkOption {
      type = lib.types.str;
      default = "${stateDir}/auth.json";
      description = ''
        pi auth.json with provider credentials. Required for OAuth providers
        such as openai-codex: bootstrap by logging in once with pi
        (`pi` -> `/login` -> OpenAI Codex) and copying the file here, owned by
        the blitzcrank user, or declaratively via {option}`authSeedFile`. It
        must stay writable because OAuth tokens auto-refresh and are persisted
        back.
      '';
    };

    authSeedFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/pi_auth_json";
      description = ''
        Secret holding a bootstrap copy of the pi auth.json (a sops-nix or
        agenix secret path). It is loaded as a systemd credential and copied
        to {option}`authFile` on start when that file is missing or when the
        secret's content changed since the last copy; refreshed OAuth tokens
        written by pi are never overwritten by a rebuild.

        Note that the copy is a bootstrap seed, not a live mirror: rotating
        refresh tokens mean the encrypted value goes stale after first use, so
        it restores a host once and then diverges.
      '';
    };

    mediaRoots = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "/mnt/media"
        "/mnt/downloads/complete"
      ];
      description = ''
        Absolute directories the read-only {command}`media_probe` tool may
        inspect with ffprobe: the media library plus the download client's
        completed directory, so a release's real audio/subtitle tracks can be
        checked before import. Paths resolving outside these roots are
        rejected. Empty (the default) disables the tool entirely.
      '';
    };

    automationsDir = lib.mkOption {
      type = lib.types.path;
      default = "${cfg.package}/lib/blitzcrank/automations";
      defaultText = lib.literalExpression ''"''${package}/lib/blitzcrank/automations"'';
      description = "Directory with automation definition .md files.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/blitzcrank.env";
      description = ''
        Environment file with secrets: SEERR_URL/SEERR_API_KEY (required),
        SONARR_/RADARR_/SABNZBD_/JELLYFIN_ URLs and API keys,
        BLITZCRANK_WEBHOOK_SECRET, and provider API keys such as
        ANTHROPIC_API_KEY when not using OAuth.
      '';
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        SEERR_BOT_USERNAME = "blitzcrank";
        ANVIL_CONTROL_SOCKET = "/run/anvil/anvild.sock";
      };
      description = "Extra non-secret environment variables.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.authSeedFile == null || lib.hasPrefix "${stateDir}/" cfg.authFile;
        message = "services.blitzcrank.authSeedFile requires authFile to live under ${stateDir}, the only path the sandboxed service can write.";
      }
      {
        assertion = lib.all (root: lib.hasPrefix "/" root) cfg.mediaRoots;
        message = "services.blitzcrank.mediaRoots entries must be absolute paths.";
      }
    ];

    systemd.services.blitzcrank = {
      description = "blitzcrank agentic Seerr issue gateway";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        BLITZCRANK_PORT = toString cfg.port;
        BLITZCRANK_MODEL = cfg.model;
        BLITZCRANK_LANGUAGE = cfg.language;
        BLITZCRANK_DATA_DIR = stateDir;
        BLITZCRANK_AUTOMATIONS_DIR = cfg.automationsDir;
        BLITZCRANK_AUTH_PATH = cfg.authFile;
      }
      // lib.optionalAttrs (cfg.mediaRoots != [ ]) {
        BLITZCRANK_MEDIA_ROOTS = lib.concatStringsSep ":" cfg.mediaRoots;
        BLITZCRANK_FFPROBE = lib.getExe' pkgs.ffmpeg-headless "ffprobe";
      }
      // cfg.settings;

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        DynamicUser = true;
        StateDirectory = "blitzcrank";
        Restart = "on-failure";
        RestartSec = 10;

        # Hardening
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
        RestrictSUIDSGID = true;
        ProtectKernelTunables = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
      }
      // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      }
      // lib.optionalAttrs (cfg.authSeedFile != null) {
        LoadCredential = [ "auth-seed:${cfg.authSeedFile}" ];
        ExecStartPre = seedAuthFile;
      };
    };
  };
}
