{
  description = "Blitzcrank Jellyfin Discord bot";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils, ... }:
    let
      nixosModule =
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
            enable = lib.mkEnableOption "Blitzcrank Jellyfin Discord bot";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.system}.default;
            };
            user = lib.mkOption {
              type = lib.types.str;
              default = "blitzcrank";
            };
            group = lib.mkOption {
              type = lib.types.str;
              default = "blitzcrank";
            };
            dataDir = lib.mkOption {
              type = lib.types.path;
              default = "/var/lib/blitzcrank";
            };
            environmentFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
            };
          };

          config = lib.mkIf cfg.enable {
            users.groups.${cfg.group} = { };
            users.users.${cfg.user} = {
              isSystemUser = true;
              group = cfg.group;
              home = cfg.dataDir;
            };

            systemd.services.blitzcrank = {
              description = "Blitzcrank Jellyfin Discord bot";
              wantedBy = [ "multi-user.target" ];
              after = [ "network-online.target" ];
              wants = [ "network-online.target" ];
              serviceConfig = {
                ExecStart = "${cfg.package}/bin/blitzcrank";
                User = cfg.user;
                Group = cfg.group;
                StateDirectory = "blitzcrank";
                WorkingDirectory = cfg.dataDir;
                Restart = "on-failure";
                NoNewPrivileges = true;
                PrivateTmp = true;
                ProtectSystem = "strict";
                ReadWritePaths = [ cfg.dataDir ];
              } // lib.optionalAttrs (cfg.environmentFile != null) {
                EnvironmentFile = cfg.environmentFile;
              };
              environment = {
                DATABASE_PATH = "${cfg.dataDir}/blitzcrank.sqlite";
                AGENT_THREADS_DIR = "${cfg.dataDir}/threads";
              };
            };
          };
        };
    in
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages.default = pkgs.buildGoModule {
          pname = "blitzcrank";
          version = "0.1.0";
          src = builtins.path {
            path = ./.;
            name = "blitzcrank-source";
            filter =
              path: type:
              let
                base = baseNameOf path;
              in
              base != ".git" && base != ".direnv" && base != ".env" && base != "result";
          };
          vendorHash = "sha256-mY6LMl7G2eFpK/MaaHzFG1A20nhPEkfafmt3fFJ5zLo=";
          subPackages = [ "cmd/blitzcrank" ];
          ldflags = [
            "-s"
            "-w"
          ];
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            go
            gopls
            go-tools
            sqlite
          ];
        };
      }
    ) // {
      nixosModules.default = nixosModule;
    };
}
