{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.blitzcrank;
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
      default = "/var/lib/blitzcrank/auth.json";
      description = ''
        pi auth.json with provider credentials. Required for OAuth providers
        such as openai-codex: bootstrap by logging in once with pi
        (`pi` -> `/login` -> OpenAI Codex) and copying the file here, owned by
        the blitzcrank user. It must stay writable because OAuth tokens
        auto-refresh and are persisted back.
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
    systemd.services.blitzcrank = {
      description = "blitzcrank agentic Seerr issue gateway";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        BLITZCRANK_PORT = toString cfg.port;
        BLITZCRANK_MODEL = cfg.model;
        BLITZCRANK_LANGUAGE = cfg.language;
        BLITZCRANK_DATA_DIR = "/var/lib/blitzcrank";
        BLITZCRANK_AUTOMATIONS_DIR = cfg.automationsDir;
        BLITZCRANK_AUTH_PATH = cfg.authFile;
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
        RestrictSuidSgid = true;
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
      };
    };
  };
}
