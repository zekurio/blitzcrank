{
  description = "Blitzcrank Jellyfin Discord bot";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      ...
    }:
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
          jsonFormat = pkgs.formats.json { };
          runtimeDefaults = jsonFormat.generate "blitzcrank-runtime-defaults.json" {
            skills_dir = cfg.skillsDir;
            automations_dir = cfg.automationsDir;
            automations_enabled = cfg.automations.enable;
            timezone = cfg.timezone;
            runtime_profiles = {
              default = runtimeProfileJSON cfg.runtime.default;
              seerr = runtimeProfileJSON cfg.runtime.seerr;
              discord = runtimeProfileJSON cfg.runtime.discord;
              automation = runtimeProfileJSON cfg.runtime.automation;
              discord_triage = runtimeProfileJSON cfg.runtime.discordTriage;
            };
          };
          runtimeProfileJSON = profile: {
            provider = profile.provider;
            model = profile.model;
            reasoning_effort = profile.reasoningEffort;
          };
          settingsEnv = {
            BOT_PUBLIC_NAME = cfg.publicName;
            DATABASE_PATH = "${cfg.dataDir}/blitzcrank.sqlite";
            RUNTIME_DEFAULT_CONFIG_PATH = runtimeDefaults;
            RUNTIME_CONFIG_PATH = cfg.runtimeConfigFile;
            AGENT_THREADS_DIR = "${cfg.dataDir}/threads";
            AUTOMATIONS_EXTRA_DIRS = lib.concatStringsSep "," cfg.extraAutomationDirs;
          };
          runtimeProfileOptions =
            {
              defaultModel ? "gpt-5.5",
              defaultReasoningEffort ? "",
            }:
            { ... }:
            {
              options = {
                provider = lib.mkOption {
                  type = lib.types.str;
                  default = "openai-compatible";
                };
                model = lib.mkOption {
                  type = lib.types.str;
                  default = defaultModel;
                };
                reasoningEffort = lib.mkOption {
                  type = lib.types.str;
                  default = defaultReasoningEffort;
                };
              };
            };
        in
        {
          imports = [
            (lib.mkRenamedOptionModule
              [ "services" "blitzcrank" "cron" "enable" ]
              [ "services" "blitzcrank" "automations" "enable" ]
            )
          ];

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
            runtimeConfigFile = lib.mkOption {
              type = lib.types.str;
              default = "${cfg.dataDir}/runtime-config.json";
            };
            publicName = lib.mkOption {
              type = lib.types.str;
              default = "Blitzcrank";
            };
            timezone = lib.mkOption {
              type = lib.types.str;
              default = "UTC";
            };
            skillsDir = lib.mkOption {
              type = lib.types.str;
              default = "${cfg.package}/share/blitzcrank/skills";
            };
            automationsDir = lib.mkOption {
              type = lib.types.str;
              default = "${cfg.package}/share/blitzcrank/automations";
            };
            extraAutomationDirs = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
            };
            automations.enable = lib.mkEnableOption "Blitzcrank Markdown automations";
            runtime = {
              default = lib.mkOption {
                type = lib.types.submodule (runtimeProfileOptions { });
                default = { };
              };
              seerr = lib.mkOption {
                type = lib.types.submodule (runtimeProfileOptions { });
                default = { };
              };
              discord = lib.mkOption {
                type = lib.types.submodule (runtimeProfileOptions { });
                default = { };
              };
              automation = lib.mkOption {
                type = lib.types.submodule (runtimeProfileOptions { });
                default = { };
              };
              discordTriage = lib.mkOption {
                type = lib.types.submodule (runtimeProfileOptions {
                  defaultModel = "gpt-5.4-mini";
                  defaultReasoningEffort = "none";
                });
                default = { };
              };
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
              }
              // lib.optionalAttrs (cfg.environmentFile != null) {
                EnvironmentFile = cfg.environmentFile;
              };
              environment = settingsEnv;
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
          nativeBuildInputs = [ pkgs.makeWrapper ];
          ldflags = [
            "-s"
            "-w"
          ];
          postInstall = ''
            mkdir -p $out/share/blitzcrank
            cp -R skills automations $out/share/blitzcrank/
            wrapProgram $out/bin/blitzcrank \
              --set-default SKILLS_DIR $out/share/blitzcrank/skills \
              --set-default AUTOMATIONS_DIR $out/share/blitzcrank/automations \
              --set-default RUNTIME_CONFIG_PATH ./runtime-config.json
          '';
        };

        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/blitzcrank";
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            go
            gopls
            go-tools
            nixfmt
            sqlite
          ];
        };

        formatter = pkgs.writeShellApplication {
          name = "blitzcrank-format";
          runtimeInputs = [ pkgs.nixfmt ];
          text = ''
            if [ "$#" -eq 0 ]; then
              exec nixfmt flake.nix
            fi
            exec nixfmt "$@"
          '';
        };
      }
    )
    // {
      nixosModules.default = nixosModule;
    };
}
