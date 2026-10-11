{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.blitzcrank-mcp;
in
{
  options.services.blitzcrank-mcp = {
    enable = lib.mkEnableOption "the blitzcrank MCP server";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The blitzcrank-mcp package to run.";
    };

    host = lib.mkOption {
      type = lib.types.nonEmptyStr;
      default = "127.0.0.1";
      example = "10.0.0.10";
      description = ''
        Listen address for the MCP server. For remote clients, bind to a
        private interface or keep loopback and use a TLS reverse proxy.
        The module does not open firewall ports.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8485;
      description = "Listen port for the MCP server.";
    };

    mediaRoots = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "/mnt/media"
        "/mnt/downloads/complete"
      ];
      description = ''
        Absolute directories the read-only media tools may inspect with
        ffprobe and ffmpeg: the media library plus the download client's
        completed directory, so a release's real audio/subtitle tracks can
        be checked before import. Paths resolving outside these roots are
        rejected. Empty (the default) disables both tools entirely.

        These must be the paths as the MCP server sees them. They are
        pulled in as mount dependencies, so the unit waits for a ZFS pool
        or network share instead of starting on an empty mountpoint.

        The server runs as a DynamicUser: the roots must be readable by
        others, or by a group listed in {option}`supplementaryGroups`.
      '';
    };

    supplementaryGroups = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "media" ];
      description = ''
        Existing groups the server's dynamic user joins, for media roots
        that are group-readable but closed to others. The unit fails to
        start when a group does not exist. The roots stay read-only for
        the server whatever the group may write.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/blitzcrank-mcp.env";
      description = ''
        Environment file with the MCP server's secrets: BLITZCRANK_MCP_TOKEN
        (required; clients must use the same token), the
        SONARR_/RADARR_/SABNZBD_/JELLYFIN_ URLs and API keys, and
        SEERR_URL/SEERR_API_KEY for the server's Seerr reads. A service
        without both its URL and API key is not served. At least one
        service or media root must be configured.
      '';
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Extra non-secret environment variables for the MCP server.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    assertions = [
      {
        assertion = lib.all (root: lib.hasPrefix "/" root && root != "/") cfg.mediaRoots;
        message = "services.blitzcrank-mcp.mediaRoots entries must be absolute paths below /.";
      }
    ];

    systemd.services.blitzcrank-mcp = {
      description = "blitzcrank MCP server for the Seerr/Arr/Jellyfin stack";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        BLITZCRANK_MCP_HOST = cfg.host;
        BLITZCRANK_MCP_PORT = toString cfg.port;
      }
      // lib.optionalAttrs (cfg.mediaRoots != [ ]) {
        BLITZCRANK_MEDIA_ROOTS = lib.concatStringsSep ":" cfg.mediaRoots;
      }
      // cfg.settings;

      # ffprobe and ffmpeg for the media tools; both are looked up on PATH.
      path = lib.optional (cfg.mediaRoots != [ ]) pkgs.ffmpeg-headless;

      # Mount dependencies keep late NFS/CIFS mounts visible in the sandbox.
      unitConfig = lib.mkIf (cfg.mediaRoots != [ ]) {
        RequiresMountsFor = cfg.mediaRoots;
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        DynamicUser = true;
        SupplementaryGroups = cfg.supplementaryGroups;
        Restart = "on-failure";
        RestartSec = 10;
        # Resolve, write, and verification can take 165 seconds in total.
        TimeoutStopSec = 180;

        # No state directory: the server is stateless. ProtectSystem makes
        # media roots read-only without pinning the mount tree at startup.
        ProtectSystem = "strict";
        ProtectHome = if lib.any (lib.hasPrefix "/home") cfg.mediaRoots then "read-only" else true;
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
      };
    };
  };
}
