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
          tomlFormat = pkgs.formats.toml { };
          writeDirs = lib.unique (
            map toString [
              cfg.dataDir
              cfg.memoriesDir
              cfg.threadsDir
              (builtins.dirOf cfg.databasePath)
            ]
          );
          defaultSettings = {
            bot.public_name = cfg.publicName;
            storage.database_path = toString cfg.databasePath;
            runtime = {
              skills_dir = cfg.skillsDir;
              automations_dir = cfg.automationsDir;
              memories_dir = toString cfg.memoriesDir;
              automations_enabled = cfg.automations.enable;
              automations_extra_dirs = cfg.extraAutomationDirs;
              threads_dir = toString cfg.threadsDir;
              timezone = cfg.timezone;
              profiles = {
                default = runtimeProfileJSON cfg.runtime.default;
                seerr = runtimeProfileJSON cfg.runtime.seerr;
                discord = runtimeProfileJSON cfg.runtime.discord;
                automation = runtimeProfileJSON cfg.runtime.automation;
                discord_triage = runtimeProfileJSON cfg.runtime.discordTriage;
                sandbox_review = runtimeProfileJSON cfg.runtime.sandboxReview;
              };
            };
          };
          serviceConfigFile = tomlFormat.generate "blitzcrank.toml" (
            lib.recursiveUpdate defaultSettings cfg.settings
          );
          serviceConfigPath = if cfg.configFile != null then cfg.configFile else serviceConfigFile;
          runtimeProfileJSON = profile: {
            provider = profile.provider;
            model = profile.model;
            reasoning_effort = profile.reasoningEffort;
          };
          settingsEnv = {
            BLITZCRANK_CONFIG = serviceConfigPath;
          };
          runtimeProfileOptions =
            {
              defaultProvider ? "",
              defaultModel ? "gpt-5.5",
              defaultReasoningEffort ? "",
            }:
            { ... }:
            {
              options = {
                provider = lib.mkOption {
                  type = lib.types.str;
                  default = defaultProvider;
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
            databasePath = lib.mkOption {
              type = lib.types.path;
              default = "${cfg.dataDir}/blitzcrank.sqlite";
              description = "Default SQLite database path rendered into generated TOML.";
            };
            memoriesDir = lib.mkOption {
              type = lib.types.path;
              default = "${cfg.dataDir}/memories";
              description = "Default durable memory directory rendered into generated TOML.";
            };
            threadsDir = lib.mkOption {
              type = lib.types.path;
              default = "${cfg.dataDir}/threads";
              description = "Default JSONL thread trace directory rendered into generated TOML.";
            };
            environmentFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              description = "Optional systemd EnvironmentFile for secret or local overrides.";
            };
            configFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              description = "Path to a TOML config file, including one produced by a secret manager. When unset, the module generates one from services.blitzcrank.settings and convenience options.";
            };
            settings = lib.mkOption {
              type = tomlFormat.type;
              default = { };
              example = {
                discord.channel_id = "123456789012345678";
                seerr = {
                  base_url = "https://seerr.example";
                  webhook_listen_addr = "127.0.0.1:8080";
                };
                runtime.profiles.default = {
                  provider = "openrouter";
                  model = "openai/gpt-5.5";
                };
              };
              description = "Blitzcrank TOML settings merged into the generated config file.";
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
                type = lib.types.submodule (runtimeProfileOptions {
                  defaultProvider = "openai-compatible";
                });
                default = { };
              };
              seerr = lib.mkOption {
                type = lib.types.submodule (runtimeProfileOptions {
                  defaultModel = "";
                });
                default = { };
              };
              discord = lib.mkOption {
                type = lib.types.submodule (runtimeProfileOptions {
                  defaultModel = "";
                });
                default = { };
              };
              automation = lib.mkOption {
                type = lib.types.submodule (runtimeProfileOptions {
                  defaultModel = "";
                });
                default = { };
              };
              discordTriage = lib.mkOption {
                type = lib.types.submodule (runtimeProfileOptions {
                  defaultModel = "gpt-5.4-mini";
                  defaultReasoningEffort = "none";
                });
                default = { };
              };
              sandboxReview = lib.mkOption {
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
            systemd.tmpfiles.rules = map (dir: "d ${dir} 0750 ${cfg.user} ${cfg.group} - -") writeDirs;

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
                ReadWritePaths = writeDirs;
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
          vendorHash = "sha256-thJHevu0+7YgyCUcZIGa8Mun/UyksZZqbWvmUAviO60=";
          subPackages = [ "cmd/blitzcrank" ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          ldflags = [
            "-s"
            "-w"
          ];
          postInstall = ''
            mkdir -p $out/share/blitzcrank
            cp -R skills automations $out/share/blitzcrank/
            printf '%s\n' \
              '[runtime]' \
              "skills_dir = \"$out/share/blitzcrank/skills\"" \
              "automations_dir = \"$out/share/blitzcrank/automations\"" \
              > $out/share/blitzcrank/config.toml
            wrapProgram $out/bin/blitzcrank \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.deno ]} \
              --set-default BLITZCRANK_CONFIG $out/share/blitzcrank/config.toml
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
            deno
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
