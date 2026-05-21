{
  description = "Blitzcrank Seerr automation gateway for Pi";

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
          defaultSettings = {
            bot.public_name = cfg.publicName;
            storage.database_path = toString cfg.databasePath;
            storage.cache_dir = "${cfg.dataDir}/cache";
            runtime = {
              threads_dir = toString cfg.threadsDir;
              automations_dir = cfg.automationsDir;
              automations_enabled = cfg.automations.enable;
              automations_extra_dirs = cfg.extraAutomationDirs;
              timezone = cfg.timezone;
            };
            pi = {
              command = cfg.piCommand;
              cwd = cfg.piCwd;
              sessions_dir = "${cfg.threadsDir}/pi-sessions";
              tool_base_url = cfg.piToolBaseURL;
              models = cfg.piModels;
            };
          };
          serviceConfigFile = tomlFormat.generate "blitzcrank.toml" (
            lib.recursiveUpdate defaultSettings cfg.settings
          );
          serviceConfigPath = if cfg.configFile != null then cfg.configFile else serviceConfigFile;
        in
        {
          options.services.blitzcrank = {
            enable = lib.mkEnableOption "Blitzcrank Seerr automation gateway";
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
            };
            threadsDir = lib.mkOption {
              type = lib.types.path;
              default = "${cfg.dataDir}/threads";
            };
            environmentFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
            };
            configFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
            };
            settings = lib.mkOption {
              type = tomlFormat.type;
              default = { };
            };
            publicName = lib.mkOption {
              type = lib.types.str;
              default = "Blitzcrank";
            };
            timezone = lib.mkOption {
              type = lib.types.str;
              default = "UTC";
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
            piCommand = lib.mkOption {
              type = lib.types.str;
              default = "${pkgs.pi-coding-agent}/bin/pi";
            };
            piCwd = lib.mkOption {
              type = lib.types.str;
              default = "${cfg.package}/share/blitzcrank";
            };
            piToolBaseURL = lib.mkOption {
              type = lib.types.str;
              default = "http://127.0.0.1:8080";
            };
            piModels = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              description = "Per-task Pi model map. Keys include default, seerr, and automation. Include thinking inline, for example anthropic/claude-sonnet-4-5:high.";
            };
          };

          config = lib.mkIf cfg.enable {
            users.groups.${cfg.group} = { };
            users.users.${cfg.user} = {
              isSystemUser = true;
              group = cfg.group;
              home = cfg.dataDir;
              createHome = true;
            };
            systemd.tmpfiles.rules = [
              "d ${cfg.dataDir} 0750 ${cfg.user} ${cfg.group} - -"
              "d ${cfg.threadsDir} 0750 ${cfg.user} ${cfg.group} - -"
              "d ${cfg.dataDir}/cache 0750 ${cfg.user} ${cfg.group} - -"
            ];
            systemd.services.blitzcrank = {
              description = "Blitzcrank Seerr automation gateway";
              wantedBy = [ "multi-user.target" ];
              after = [ "network-online.target" ];
              wants = [ "network-online.target" ];
              environment = {
                BLITZCRANK_CONFIG = serviceConfigPath;
              };
              serviceConfig = {
                User = cfg.user;
                Group = cfg.group;
                WorkingDirectory = cfg.dataDir;
                ExecStart = "${cfg.package}/bin/blitzcrank";
                Restart = "on-failure";
                RestartSec = "5s";
                EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
              };
            };
          };
        };
    in
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
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
          vendorHash = "sha256-s7jdUifNKa8KKlQy+9clttVdeWc9x+zB50LNiiMPbgM=";
          subPackages = [ "cmd/blitzcrank" ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postInstall = ''
            mkdir -p $out/share/blitzcrank
            cp -R automations .pi $out/share/blitzcrank/
            printf '%s\n' \
              '[runtime]' \
              "automations_dir = \"$out/share/blitzcrank/automations\"" \
              '[pi]' \
              "cwd = \"$out/share/blitzcrank\"" \
              > $out/share/blitzcrank/config.toml
            wrapProgram $out/bin/blitzcrank \
              --prefix PATH : ${
                pkgs.lib.makeBinPath [
                  pkgs.deno
                  pkgs.pi-coding-agent
                ]
              } \
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
            pi-coding-agent
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
