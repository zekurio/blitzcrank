{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.blitzcrank;
  stateDir = "/var/lib/blitzcrank";

  # The server module is optional here: it may not be imported at all when the
  # server runs on another machine.
  localMcp = lib.optional (config.services.blitzcrank-mcp.enable or false) "blitzcrank-mcp.service";

  authEnvironment =
    lib.mapAttrsToList (
      name: value: "--setenv=${name}=${toString value}"
    ) config.systemd.services.blitzcrank.environment
    ++ lib.optional (cfg.environmentFile != null) "--property=EnvironmentFile=${cfg.environmentFile}";

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

  cli = pkgs.writeShellApplication {
    name = "blitzcrank";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.systemd
      pkgs.util-linux
    ];
    text = ''
      # Keep one CLI. Only auth needs access to the service-owned state.
      if [ "''${1:-}" != auth ] || [ "$#" -lt 2 ]; then
        exec ${lib.getExe cfg.package} "$@"
      fi
      case "''${2:-}" in
        -h | --help | help) exec ${lib.getExe cfg.package} "$@" ;;
      esac

      if [ "$(id -u)" -ne 0 ]; then
        echo "service authentication must be run as root (try sudo blitzcrank auth)" >&2
        exit 1
      fi
      if [ ! -t 0 ] || [ ! -t 1 ]; then
        echo "service authentication requires an interactive terminal" >&2
        exit 1
      fi

      exec 9>/run/blitzcrank-auth.lock
      if ! flock --nonblock 9; then
        echo "another blitzcrank auth command is already running" >&2
        exit 1
      fi

      # Recover a transient unit left behind if the previous helper was killed.
      systemctl stop blitzcrank-auth.service >/dev/null 2>&1 || true

      restore_stamp=/run/blitzcrank-auth.restore
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
        systemctl stop blitzcrank-auth.service >/dev/null 2>&1 || true
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
        --unit=blitzcrank-auth.service \
        --description="Blitzcrank provider authentication" \
        --service-type=exec \
        --property=Conflicts=blitzcrank.service \
        --property=DynamicUser=yes \
        --property=User=blitzcrank \
        --property=StateDirectory=blitzcrank \
        --property=NoNewPrivileges=yes \
        --property=ProtectSystem=strict \
        --property=PrivateTmp=yes \
        ${lib.escapeShellArgs authEnvironment} \
        --working-directory=${stateDir} \
        --pty \
        --wait \
        --collect \
        ${lib.getExe cfg.package} "$@"
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
      type = lib.types.nonEmptyStr;
      example = "openai/gpt-6-astra:high";
      description = ''
        Required model for issue runs as provider/model with an optional thinking suffix.
        There is no built-in model choice.
        API-key providers (anthropic, openai, ...) authenticate via environment
        variables from {option}`environmentFile`. OAuth providers
        (openai, ...) authenticate via the auth file, see
        {option}`authFile`.
      '';
    };

    language = lib.mkOption {
      type = lib.types.str;
      default = "German";
      description = "Language for public comments.";
    };

    gateways = lib.mkOption {
      type = lib.types.nonEmptyListOf (
        lib.types.enum [
          "seerr"
          "discord"
        ]
      );
      default = [ "seerr" ];
      description = ''
        Gateways the host runs. Each reads its own settings, and a listed
        gateway without them stops the service at startup. Pending work for
        a gateway that is no longer listed also stops it.

        "discord" needs DISCORD_BOT_TOKEN in {option}`environmentFile`, the
        triage provider's API key there or in the auth file, and
        DISCORD_CHANNELS, DISCORD_ALLOWED_USERS or DISCORD_ALLOWED_ROLES, and
        DISCORD_TRIAGE_MODEL in {option}`settings`.
      '';
    };

    webProvider = lib.mkOption {
      type = lib.types.enum [
        "none"
        "firecrawl"
      ];
      default = "none";
      description = ''
        External web provider for issue runs.
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
        Writable auth.json with provider credentials. Required for OAuth providers
        such as openai with ChatGPT subscription auth. Bootstrap interactively
        with {command}`sudo blitzcrank auth login openai`, or declaratively via
        {option}`authSeedFile`. It must stay writable because OAuth tokens
        auto-refresh and are persisted back. The auth helper also stores a
        stable installation UUID at {option}`authFile` + ".device-id".
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

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/blitzcrank.env";
      description = ''
        Environment file with the host's secrets: SEERR_URL/SEERR_API_KEY
        (required for the seerr gateway; the host comments on issues itself),
        DISCORD_BOT_TOKEN (required for the discord gateway),
        BLITZCRANK_MCP_TOKEN (required; must be the same token as in
        the MCP server's environment file), BLITZCRANK_WEBHOOK_SECRET,
        FIRECRAWL_API_KEY when {option}`webProvider` is "firecrawl", and
        provider API keys such as ANTHROPIC_API_KEY when not using OAuth.

        Sonarr, Radarr, SABnzbd, and Jellyfin credentials do not belong here:
        only the MCP server holds them.
      '';
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        SEERR_BOT_USERNAME = "blitzcrank";
      };
      description = "Extra non-secret environment variables.";
    };

    mcpUrl = lib.mkOption {
      type = lib.types.nonEmptyStr;
      example = "http://127.0.0.1:8485/mcp";
      description = ''
        Required MCP endpoint the host connects to at the start of every run.
        The server is configured independently with services.blitzcrank-mcp
        or runs on another machine. Use TLS or a private network outside
        loopback: the bearer token travels with every request.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cli ];

    assertions = [
      {
        assertion = cfg.authSeedFile == null || lib.hasPrefix "${stateDir}/" cfg.authFile;
        message = "services.blitzcrank.authSeedFile requires authFile to live under ${stateDir}, the only path the sandboxed service can write.";
      }
    ];

    systemd.services.blitzcrank = {
      description = "blitzcrank agentic Seerr issue gateway";
      wantedBy = [ "multi-user.target" ];
      # The host checks the server at startup and gives up after about 20
      # seconds, less than the server's unit may wait for its media mounts.
      # Ordering also stops the host first, so its runs drain while the server
      # still answers. Wants, not Requires: a server restart must not stop the
      # host.
      after = [ "network-online.target" ] ++ localMcp;
      wants = [ "network-online.target" ] ++ localMcp;

      environment = {
        BLITZCRANK_PORT = toString cfg.port;
        BLITZCRANK_MODEL = cfg.model;
        BLITZCRANK_LANGUAGE = cfg.language;
        BLITZCRANK_GATEWAYS = lib.concatStringsSep "," cfg.gateways;
        BLITZCRANK_DATA_DIR = stateDir;
        BLITZCRANK_AUTH_PATH = cfg.authFile;
        BLITZCRANK_WEB_PROVIDER = cfg.webProvider;
        BLITZCRANK_MCP_URL = cfg.mcpUrl;
      }
      // cfg.settings;

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        DynamicUser = true;
        StateDirectory = "blitzcrank";
        Restart = "on-failure";
        RestartSec = 10;

        # Hardening. The host reads no media and holds no Arr credentials.
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
