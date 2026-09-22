{
  nixpkgs,
  pkgs,
  module,
}:

let
  package = pkgs.writeShellScriptBin "blitzcrank" "exit 0";
  baseConfig = {
    enable = true;
    inherit package;
    config.seerr = {
      url = "https://seerr.invalid";
      apiKey.env = "SEERR_API_KEY";
    };
  };
  eval =
    serviceConfig:
    nixpkgs.lib.nixosSystem {
      system = pkgs.stdenv.hostPlatform.system;
      modules = [
        module
        {
          system.stateVersion = "25.11";
          fileSystems."/" = {
            device = "none";
            fsType = "tmpfs";
          };
          boot.loader.grub.enable = false;
          services.blitzcrank = nixpkgs.lib.recursiveUpdate baseConfig serviceConfig;
        }
      ];
    };
  evaluated = eval {
    config = {
      authPath = "/var/lib/blitzcrank/pi/auth.json";
      media.roots = [
        "/home/media"
        "/mnt/downloads"
      ];
      gateways.discord = {
        token.file = "/run/credentials/blitzcrank.service/discord-token";
        guilds = [
          {
            guildId = "1";
            reportChannelId = "2";
          }
          {
            guildId = "3";
            reportChannelId = "4";
            inboxChannelIds = [ "5" ];
            adminRoleIds = [ "6" ];
            model = "provider/model";
            triageModel = "provider/triage";
          }
        ];
      };
    };
  };
  result = evaluated.config;
  options = evaluated.options.services.blitzcrank;
  generated = result.systemd.services.blitzcrank.environment.BLITZCRANK_CONFIG;
  noMedia = (eval { }).config.systemd.services.blitzcrank;
  failedAssertions =
    serviceConfig:
    builtins.any (assertion: !assertion.assertion) (eval serviceConfig).config.assertions;
  inlineSecret = builtins.tryEval (
    (eval { config.seerr.apiKey = "not-a-reference"; }).config.system.build.toplevel.drvPath
  );
  dataDirOverride = builtins.tryEval (
    (eval { config.dataDir = "/srv/blitzcrank"; }).config.system.build.toplevel.drvPath
  );
in
assert !failedAssertions { };
assert
  (eval { config.media.roots = [ "/home" ]; })
  .config.systemd.services.blitzcrank.serviceConfig.ProtectHome == "read-only";
assert
  result.systemd.services.blitzcrank.unitConfig.RequiresMountsFor == [
    "/home/media"
    "/mnt/downloads"
  ];
assert result.systemd.services.blitzcrank.serviceConfig.ProtectHome == "read-only";
assert builtins.elem pkgs.ffmpeg-headless result.systemd.services.blitzcrank.path;
assert !(builtins.elem pkgs.ffmpeg-headless noMedia.path);
assert noMedia.serviceConfig.ProtectHome == true;
assert !(options ? settings);
assert !(options ? port);
assert !(options ? model);
assert !(options ? authFile);
assert !(options ? mediaRoots);
assert !(options.config.type.getSubOptions [ ] ? dataDir);
assert !inlineSecret.success;
assert !dataDirOverride.success;
assert failedAssertions { config.authPath = "/tmp/auth.json"; };
assert failedAssertions { config.authPath = "/var/lib/blitzcrank/../auth.json"; };
assert failedAssertions {
  config.gateways.discord = {
    token.env = "DISCORD_TOKEN";
    guilds = [
      {
        guildId = "same";
        reportChannelId = "1";
      }
      {
        guildId = "same";
        reportChannelId = "2";
      }
    ];
  };
};
pkgs.runCommand "blitzcrank-module-checks"
  {
    nativeBuildInputs = [ pkgs.jq ];
  }
  ''
    jq -e '
      .version == 1
      and .port == 8484
      and .model == "anthropic/claude-sonnet-4-5"
      and .authPath == "/var/lib/blitzcrank/pi/auth.json"
      and .dataDir == "/var/lib/blitzcrank"
      and (.automationsDir | endswith("/lib/blitzcrank/automations"))
      and .media.roots == ["/home/media", "/mnt/downloads"]
      and .gateways == {
        "discord": {
          "guilds": [
            {
              "adminRoleIds": [],
              "guildId": "1",
              "inboxChannelIds": [],
              "reportChannelId": "2"
            },
            {
              "adminRoleIds": ["6"],
              "guildId": "3",
              "inboxChannelIds": ["5"],
              "model": "provider/model",
              "reportChannelId": "4",
              "triageModel": "provider/triage"
            }
          ],
          "token": {"file": "/run/credentials/blitzcrank.service/discord-token"}
        }
      }
      and (.gateways.discord | has("id") | not)
      and (.gateways.discord | has("type") | not)
      and all(..; . != null)
    ' ${generated} >/dev/null
    touch "$out"
  ''
