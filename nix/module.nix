{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.blitzcrank;
  stateDir = "/var/lib/blitzcrank";
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
        description = "API key reference as either { env = \"NAME\"; } or { file = \"/path\"; }.";
      };
    };
  };
  guildType = lib.types.submodule {
    options = {
      guildId = lib.mkOption { type = lib.types.nonEmptyStr; };
      reportChannelId = lib.mkOption { type = lib.types.nonEmptyStr; };
      inboxChannelIds = lib.mkOption {
        type = lib.types.listOf lib.types.nonEmptyStr;
        default = [ ];
      };
      adminRoleIds = lib.mkOption {
        type = lib.types.listOf lib.types.nonEmptyStr;
        default = [ ];
      };
      model = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
      };
      triageModel = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
      };
    };
  };
  structuredConfigType = lib.types.submodule {
    options = {
      version = lib.mkOption {
        type = lib.types.enum [ 1 ];
        default = 1;
      };
      port = lib.mkOption {
        type = lib.types.port;
        default = 8484;
      };
      automationsDir = lib.mkOption {
        type = lib.types.str;
        default = "${cfg.package}/lib/blitzcrank/automations";
      };
      model = lib.mkOption {
        type = lib.types.nonEmptyStr;
        default = "anthropic/claude-sonnet-4-5";
      };
      automationModel = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
      };
      automationModels = lib.mkOption {
        type = lib.types.attrsOf lib.types.nonEmptyStr;
        default = { };
      };
      authPath = lib.mkOption {
        type = lib.types.str;
        default = "${stateDir}/auth.json";
        description = "Writable pi authentication file below ${stateDir}.";
      };
      modelsPath = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
      };
      language = lib.mkOption {
        type = lib.types.str;
        default = "German";
      };
      webhookSecret = lib.mkOption {
        type = lib.types.nullOr secretType;
        default = null;
      };
      seerrBotUserId = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
      };
      seerrBotUsername = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
      };
      seerr = lib.mkOption {
        type = serviceType;
        description = "Required Seerr connection.";
      };
      sonarr = lib.mkOption {
        type = lib.types.nullOr serviceType;
        default = null;
      };
      radarr = lib.mkOption {
        type = lib.types.nullOr serviceType;
        default = null;
      };
      sabnzbd = lib.mkOption {
        type = lib.types.nullOr serviceType;
        default = null;
      };
      jellyfin = lib.mkOption {
        type = lib.types.nullOr serviceType;
        default = null;
      };
      anvil = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.submodule {
            options = {
              command = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
              };
              socket = lib.mkOption { type = lib.types.str; };
            };
          }
        );
        default = null;
      };
      media = lib.mkOption {
        type = lib.types.submodule {
          options.roots = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
          };
        };
        default = { };
      };
      web = lib.mkOption {
        type = lib.types.submodule {
          options = {
            provider = lib.mkOption {
              type = lib.types.enum [
                "none"
                "firecrawl"
              ];
              default = "none";
            };
            apiKey = lib.mkOption {
              type = lib.types.nullOr secretType;
              default = null;
            };
          };
        };
        default = { };
      };
      gateways = lib.mkOption {
        type = lib.types.submodule {
          options.discord = lib.mkOption {
            type = lib.types.nullOr (
              lib.types.submodule {
                options = {
                  token = lib.mkOption { type = secretType; };
                  guilds = lib.mkOption {
                    type = lib.types.nonEmptyListOf guildType;
                  };
                };
              }
            );
            default = null;
          };
        };
        default = { };
      };
    };
  };
  generatedConfig = jsonFormat.generate "blitzcrank-config.json" (
    stripNulls cfg.config
    // {
      dataDir = stateDir;
    }
  );
  mediaRoots = cfg.config.media.roots;
  authPathParts = lib.splitString "/" (lib.removePrefix "${stateDir}/" cfg.config.authPath);
  authPathIsManaged =
    lib.hasPrefix "${stateDir}/" cfg.config.authPath
    && lib.all (part: part != "" && part != "." && part != "..") authPathParts;
  guildIds =
    if cfg.config.gateways.discord == null then
      [ ]
    else
      map (guild: guild.guildId) cfg.config.gateways.discord.guilds;

  seedAuthFile = pkgs.writeShellScript "blitzcrank-seed-auth" ''
    set -eu
    seed="$CREDENTIALS_DIRECTORY/auth-seed"
    auth=${lib.escapeShellArg cfg.config.authPath}
    stamp="$auth.seed-sha256"
    sum="$(${pkgs.coreutils}/bin/sha256sum "$seed" | ${pkgs.coreutils}/bin/cut -d' ' -f1)"
    if [ -s "$auth" ] && [ "$(${pkgs.coreutils}/bin/cat "$stamp" 2>/dev/null || true)" = "$sum" ]; then
      exit 0
    fi
    ${pkgs.coreutils}/bin/install -D -m 600 "$seed" "$auth"
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
        --setenv=${lib.escapeShellArg "PI_CODING_AGENT_DIR=${builtins.dirOf cfg.config.authPath}"} \
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
    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Environment file for secrets referenced by config and model provider authentication.";
    };
    authSeedFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Bootstrap pi auth.json loaded as a systemd credential.";
    };
    config = lib.mkOption {
      type = structuredConfigType;
      description = ''
        Versioned application configuration written to JSON. Secrets must use
        `{ env = "NAME"; }` or `{ file = "/path"; }`.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ statePi ];
    assertions = [
      {
        assertion = authPathIsManaged && builtins.baseNameOf cfg.config.authPath == "auth.json";
        message = "services.blitzcrank.config.authPath must be a normalized auth.json path below ${stateDir}.";
      }
      {
        assertion = lib.all (root: lib.hasPrefix "/" root && root != "/") mediaRoots;
        message = "services.blitzcrank.config.media.roots entries must be absolute paths below /.";
      }
      {
        assertion = lib.length guildIds == lib.length (lib.unique guildIds);
        message = "services.blitzcrank.config.gateways.discord.guilds must have unique guildId values.";
      }
    ];
    systemd.services.blitzcrank = {
      description = "blitzcrank agentic Seerr issue gateway";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment.BLITZCRANK_CONFIG = generatedConfig;
      path = lib.optional (mediaRoots != [ ]) pkgs.ffmpeg-headless;
      unitConfig = lib.mkIf (mediaRoots != [ ]) {
        RequiresMountsFor = mediaRoots;
      };
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        DynamicUser = true;
        StateDirectory = "blitzcrank";
        Restart = "on-failure";
        RestartSec = 10;
        ProtectSystem = "strict";
        ProtectHome =
          if lib.any (root: root == "/home" || lib.hasPrefix "/home/" root) mediaRoots then
            "read-only"
          else
            true;
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
