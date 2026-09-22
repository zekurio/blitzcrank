{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.blitzcrank;
  stateDir = "/var/lib/blitzcrank";
  effectiveAuthFile =
    if cfg.config != null && cfg.config.authPath != null then cfg.config.authPath else cfg.authFile;
  jsonFormat = pkgs.formats.json { };
  stripNulls =
    value:
    if builtins.isAttrs value then
      lib.mapAttrs (_: stripNulls) (lib.filterAttrs (_: item: item != null) value)
    else if builtins.isList value then
      map stripNulls (builtins.filter (item: item != null) value)
    else
      value;

  secretType = lib.types.addCheck (lib.types.attrsOf lib.types.str) (
    secret:
    let
      names = builtins.attrNames secret;
    in
    names == [ "env" ] || names == [ "file" ]
  );

  serviceType = lib.types.submodule {
    options = {
      url = lib.mkOption {
        type = lib.types.str;
        description = "Service base URL.";
      };
      apiKey = lib.mkOption {
        type = secretType;
        description = "API key reference, as either { env = \"NAME\"; } or { file = \"/path\"; }.";
      };
    };
  };

  structuredConfigType = lib.types.submodule {
    options = {
      version = lib.mkOption {
        type = lib.types.enum [ 1 ];
        default = 1;
        description = "Configuration file format version.";
      };
      port = lib.mkOption {
        type = lib.types.nullOr lib.types.port;
        default = null;
        description = "Listen port. Defaults to {option}`services.blitzcrank.port`.";
      };
      dataDir = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Runtime data directory. Defaults to the module-managed state directory.";
      };
      automationsDir = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Automation definitions directory. Defaults to the module convenience option.";
      };
      model = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Model for issue runs. Defaults to {option}`services.blitzcrank.model`.";
      };
      automationModel = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Default model for automation runs.";
      };
      automationModels = lib.mkOption {
        type = lib.types.nullOr (lib.types.attrsOf lib.types.str);
        default = null;
        description = "Per-automation model overrides.";
      };
      authPath = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Writable pi authentication file. Defaults to the module convenience option.";
      };
      modelsPath = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Path to a pi models file.";
      };
      language = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Language for public comments and notes.";
      };
      webhookSecret = lib.mkOption {
        type = lib.types.nullOr secretType;
        default = null;
        description = "Webhook secret reference.";
      };
      seerrBotUserId = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Seerr bot user ID.";
      };
      seerrBotUsername = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Seerr bot username.";
      };
      seerr = lib.mkOption {
        type = serviceType;
        description = "Required Seerr connection.";
      };
      sonarr = lib.mkOption {
        type = lib.types.nullOr serviceType;
        default = null;
        description = "Sonarr connection.";
      };
      radarr = lib.mkOption {
        type = lib.types.nullOr serviceType;
        default = null;
        description = "Radarr connection.";
      };
      sabnzbd = lib.mkOption {
        type = lib.types.nullOr serviceType;
        default = null;
        description = "SABnzbd connection.";
      };
      jellyfin = lib.mkOption {
        type = lib.types.nullOr serviceType;
        default = null;
        description = "Jellyfin connection.";
      };
      anvil = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.submodule {
            options = {
              command = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "anvilctl command.";
              };
              socket = lib.mkOption {
                type = lib.types.str;
                description = "Anvil control socket.";
              };
            };
          }
        );
        default = null;
        description = "Anvil connection.";
      };
      media = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.submodule {
            options.roots = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              description = "Media roots available to media_probe.";
            };
          }
        );
        default = null;
        description = "Media probing configuration.";
      };
      web = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.submodule {
            options = {
              provider = lib.mkOption {
                type = lib.types.enum [
                  "none"
                  "firecrawl"
                ];
                description = "External web provider.";
              };
              apiKey = lib.mkOption {
                type = lib.types.nullOr secretType;
                default = null;
                description = "Web provider API key reference.";
              };
            };
          }
        );
        default = null;
        description = "External web lookup configuration.";
      };
      gateways = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.listOf (
            lib.types.submodule {
              options = {
                id = lib.mkOption { type = lib.types.str; };
                type = lib.mkOption {
                  type = lib.types.enum [ "discord" ];
                };
                token = lib.mkOption { type = secretType; };
                guildId = lib.mkOption { type = lib.types.str; };
                reportChannelId = lib.mkOption { type = lib.types.str; };
                inboxChannelIds = lib.mkOption {
                  type = lib.types.nullOr (lib.types.listOf lib.types.str);
                  default = null;
                };
                model = lib.mkOption {
                  type = lib.types.nullOr lib.types.str;
                  default = null;
                };
                triageModel = lib.mkOption {
                  type = lib.types.nullOr lib.types.str;
                  default = null;
                };
                adminRoleIds = lib.mkOption {
                  type = lib.types.nullOr (lib.types.listOf lib.types.str);
                  default = null;
                };
              };
            }
          )
        );
        default = null;
        description = "Configured host-side gateways.";
      };
    };
  };

  structuredDefaults = {
    version = 1;
    port = cfg.port;
    dataDir = stateDir;
    automationsDir = toString cfg.automationsDir;
    model = cfg.model;
    authPath = cfg.authFile;
    language = cfg.language;
    web = {
      provider = cfg.webProvider;
    }
    // lib.optionalAttrs (cfg.webProvider == "firecrawl") {
      apiKey.env = "FIRECRAWL_API_KEY";
    };
  }
  // lib.optionalAttrs (cfg.automationModel != null) {
    automationModel = cfg.automationModel;
  }
  // lib.optionalAttrs (cfg.automationModels != { }) {
    automationModels = cfg.automationModels;
  }
  // lib.optionalAttrs (cfg.mediaRoots != [ ]) {
    media.roots = cfg.mediaRoots;
  };
  generatedConfig =
    if cfg.config == null then
      null
    else
      jsonFormat.generate "blitzcrank-config.json" (
        structuredDefaults // stripNulls cfg.config
      );
  effectiveMediaRoots =
    if cfg.config != null && cfg.config.media != null then cfg.config.media.roots else cfg.mediaRoots;

  # Seeds {option}`authFile` from a read-only secret (sops, agenix, ...) that
  # systemd exposes as a credential. The live file must stay writable — pi
  # refreshes OAuth tokens in place — so the secret is copied, not linked, and
  # only when its content differs from the last seeded content (recorded next
  # to it). Rebuilds therefore never clobber refreshed tokens, while rotating
  # the secret does take effect on the next start.
  seedAuthFile = pkgs.writeShellScript "blitzcrank-seed-auth" ''
    set -eu
    seed="$CREDENTIALS_DIRECTORY/auth-seed"
    stamp="${effectiveAuthFile}.seed-sha256"
    sum="$(${pkgs.coreutils}/bin/sha256sum "$seed" | ${pkgs.coreutils}/bin/cut -d' ' -f1)"
    if [ -s "${effectiveAuthFile}" ] && [ "$(${pkgs.coreutils}/bin/cat "$stamp" 2>/dev/null || true)" = "$sum" ]; then
      exit 0
    fi
    ${pkgs.coreutils}/bin/install -m 600 "$seed" "${effectiveAuthFile}"
    printf '%s\n' "$sum" > "$stamp"
  '';

  statePi = pkgs.writeShellApplication {
    name = "blitzcrank-pi";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.systemd
      pkgs.util-linux
    ];
    text = ''
      if [ "$(id -u)" -ne 0 ]; then
        echo "blitzcrank-pi must be run as root (try sudo)" >&2
        exit 1
      fi
      if [ ! -t 0 ] || [ ! -t 1 ]; then
        echo "blitzcrank-pi requires an interactive terminal" >&2
        exit 1
      fi

      exec 9>/run/blitzcrank-pi.lock
      if ! flock --nonblock 9; then
        echo "another blitzcrank-pi session is already running" >&2
        exit 1
      fi

      # Recover a transient unit left behind if the previous helper was killed.
      systemctl stop blitzcrank-pi.service >/dev/null 2>&1 || true

      restore_stamp=/run/blitzcrank-pi.restore
      restore_service=0
      if [ -e "$restore_stamp" ]; then
        restore_service=1
      fi
      case "$(systemctl is-active blitzcrank.service || true)" in
        active | activating | reloading) restore_service=1 ;;
      esac
      if [ "$restore_service" -eq 1 ]; then
        # Preserve restoration intent across SIGKILL, which cannot be trapped.
        : > "$restore_stamp"
      fi

      cleanup() {
        status=$?
        trap - EXIT HUP INT TERM
        systemctl stop blitzcrank-pi.service >/dev/null 2>&1 || true
        if [ "$restore_service" -eq 1 ]; then
          if systemctl start blitzcrank.service; then
            rm -f "$restore_stamp"
          else
            echo "failed to restart blitzcrank.service" >&2
            status=1
          fi
        fi
        exit "$status"
      }
      trap cleanup EXIT
      trap 'exit 129' HUP
      trap 'exit 130' INT
      trap 'exit 143' TERM

      # Stop even an activating unit so the login cannot race token refreshes.
      systemctl stop blitzcrank.service

      systemd-run \
        --unit=blitzcrank-pi.service \
        --description="Interactive pi instance for blitzcrank" \
        --service-type=exec \
        --property=Conflicts=blitzcrank.service \
        --property=DynamicUser=yes \
        --property=User=blitzcrank \
        --property=StateDirectory=blitzcrank \
        --property=NoNewPrivileges=yes \
        --property=ProtectSystem=strict \
        --property=PrivateTmp=yes \
        --setenv=PI_CODING_AGENT_DIR=${stateDir} \
        --working-directory=${stateDir} \
        --pty \
        --wait \
        --collect \
        ${lib.getExe' cfg.package "blitz-pi"} \
        --no-session
    '';
  };
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
      example = "openai-codex/gpt-5.2-codex:high";
      description = ''
        Model for issue runs as provider/model with an optional thinking suffix.
        API-key providers (anthropic, openai, ...) authenticate via environment
        variables from {option}`environmentFile`. OAuth providers
        (openai-codex, ...) authenticate via the auth file, see
        {option}`authFile`.
      '';
    };

    automationModel = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "openai-codex/gpt-5.6-terra:high";
      description = ''
        Default model for automation runs as provider/model with an optional
        thinking suffix. Null inherits {option}`model`.
      '';
    };

    automationModels = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        stale-import-handler = "openai-codex/gpt-5.6-terra:high";
      };
      description = ''
        Per-automation model overrides keyed by automation name. Entries use
        provider/model with an optional thinking suffix. Unknown automation
        names or unavailable models stop the service at startup.
      '';
    };

    language = lib.mkOption {
      type = lib.types.str;
      default = "German";
      description = "Language for public comments and operations notes.";
    };

    webProvider = lib.mkOption {
      type = lib.types.enum [
        "none"
        "firecrawl"
      ];
      default = "none";
      description = ''
        External web provider for issue runs and Discord conversations.
        "firecrawl" grants the read-only web_search and web_extract tools
        through Firecrawl's hosted API and needs FIRECRAWL_API_KEY in
        {option}`environmentFile`. Custom endpoints are not supported. "none"
        grants no external web tools.
      '';
    };

    authFile = lib.mkOption {
      type = lib.types.str;
      default = "${stateDir}/auth.json";
      description = ''
        pi auth.json with provider credentials. Required for OAuth providers
        such as openai-codex. With the default path, bootstrap interactively
        with {command}`sudo blitzcrank-pi`, or declaratively via
        {option}`authSeedFile`. It must stay writable because OAuth tokens
        auto-refresh and are persisted back.
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

        These must be the paths *as blitzcrank sees them*: if Sonarr runs in a
        container with a different mapping, the probe needs the host path. They
        are pulled in as mount dependencies, so the unit waits for a ZFS pool or
        network share instead of starting on an empty mountpoint.

        The service runs as a {option}`DynamicUser` with no supplementary
        groups: the roots must be readable by `others`, or the unit needs
        {option}`systemd.services.blitzcrank.serviceConfig.SupplementaryGroups`
        and `DynamicUser = false`.
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
        ANVIL_CONTROL_SOCKET/ANVIL_COMMAND, BLITZCRANK_WEBHOOK_SECRET,
        DISCORD_BOT_TOKEN, FIRECRAWL_API_KEY when
        {option}`webProvider` is "firecrawl", and provider API keys
        such as ANTHROPIC_API_KEY when not using OAuth.
      '';
    };

    config = lib.mkOption {
      type = lib.types.nullOr structuredConfigType;
      default = null;
      description = ''
        Structured, versioned blitzcrank configuration. When set, the module
        writes JSON with {function}`pkgs.formats.json` and points
        BLITZCRANK_CONFIG at it. The port, model, automation, auth, language,
        web-provider, and media-root convenience options supply defaults;
        values here take precedence.

        Secrets must use `{ env = "NAME"; }` or `{ file = "/path"; }`.
        Inline secret strings are intentionally rejected so they cannot enter
        the Nix store. The selected environment variables may come from
        {option}`environmentFile`; file references may name systemd credential
        paths.

        Setting this switches off legacy environment configuration. Do not use
        {option}`settings` at the same time.
      '';
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        SEERR_BOT_USERNAME = "blitzcrank";
        ANVIL_CONTROL_SOCKET = "/run/anvil/anvild.sock";
        ANVIL_COMMAND = "/run/current-system/sw/bin/anvilctl";
        DISCORD_GUILD_ID = "000000000000000000";
        DISCORD_WATCH_CHANNEL_ID = "000000000000000000";
      };
      description = "Extra non-secret environment variables.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ statePi ];

    assertions = [
      {
        assertion = cfg.authSeedFile == null || lib.hasPrefix "${stateDir}/" effectiveAuthFile;
        message = "services.blitzcrank.authSeedFile requires authFile to live under ${stateDir}, the only path the sandboxed service can write.";
      }
      {
        assertion = lib.all (root: lib.hasPrefix "/" root && root != "/") effectiveMediaRoots;
        message = "services.blitzcrank.mediaRoots entries must be absolute paths below /.";
      }
      {
        assertion = cfg.config == null || cfg.settings == { };
        message = "services.blitzcrank.settings cannot be used with structured services.blitzcrank.config.";
      }
    ];

    systemd.services.blitzcrank = {
      description = "blitzcrank agentic Seerr issue gateway";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment =
        if generatedConfig != null then
          { BLITZCRANK_CONFIG = generatedConfig; }
        else
          {
            BLITZCRANK_PORT = toString cfg.port;
            BLITZCRANK_MODEL = cfg.model;
            BLITZCRANK_LANGUAGE = cfg.language;
            BLITZCRANK_DATA_DIR = stateDir;
            BLITZCRANK_AUTOMATIONS_DIR = cfg.automationsDir;
            BLITZCRANK_AUTH_PATH = cfg.authFile;
            BLITZCRANK_WEB_PROVIDER = cfg.webProvider;
          }
          // lib.optionalAttrs (cfg.automationModel != null) {
            BLITZCRANK_AUTOMATION_MODEL = cfg.automationModel;
          }
          // lib.optionalAttrs (cfg.automationModels != { }) {
            BLITZCRANK_AUTOMATION_MODELS = builtins.toJSON cfg.automationModels;
          }
          // lib.optionalAttrs (cfg.mediaRoots != [ ]) {
            BLITZCRANK_MEDIA_ROOTS = lib.concatStringsSep ":" cfg.mediaRoots;
          }
          // cfg.settings;

      # ffprobe for media_probe; it is looked up on PATH.
      path = lib.optional (effectiveMediaRoots != [ ]) pkgs.ffmpeg-headless;

      # Media roots must exist before the probe can read them; without this a
      # late NFS/CIFS mount is invisible inside the unit's mount namespace.
      unitConfig = lib.mkIf (effectiveMediaRoots != [ ]) {
        RequiresMountsFor = effectiveMediaRoots;
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        DynamicUser = true;
        StateDirectory = "blitzcrank";
        Restart = "on-failure";
        RestartSec = 10;

        # Hardening. ProtectSystem=strict already mounts every media root
        # read-only; binding them in as well would pin the mount tree as it
        # looks at unit start, which hides datasets mounted later.
        ProtectSystem = "strict";
        # Media libraries under /home stay reachable; nothing is writable.
        ProtectHome = if lib.any (lib.hasPrefix "/home") effectiveMediaRoots then "read-only" else true;
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
