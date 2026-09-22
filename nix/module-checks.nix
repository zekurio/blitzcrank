{
  nixpkgs,
  pkgs,
  module,
}:

let
  package = pkgs.writeShellScriptBin "blitzcrank" "exit 0";
  eval =
    config:
    (nixpkgs.lib.nixosSystem {
      system = pkgs.stdenv.hostPlatform.system;
      modules = [
        module
        {
          system.stateVersion = "25.11";
          services.blitzcrank = {
            enable = true;
            inherit package;
          }
          // config;
        }
      ];
    }).config;

  structured = eval {
    webProvider = "firecrawl";
    automationModels.convenience = "provider/convenience";
    mediaRoots = [ "/mnt/convenience" ];
    config = {
      seerr = {
        url = "https://seerr.invalid";
        apiKey.env = "SEERR_API_KEY";
      };
      automationModels = { };
      media.roots = [ "/mnt/structured" ];
      gateways = [
        {
          id = "default";
          type = "discord";
          token.env = "DISCORD_BOT_TOKEN";
          guildId = "1";
          reportChannelId = "2";
        }
      ];
    };
  };
  generated = structured.systemd.services.blitzcrank.environment.BLITZCRANK_CONFIG;
  legacy = eval { };
in
assert structured.systemd.services.blitzcrank.unitConfig.RequiresMountsFor == [ "/mnt/structured" ];
assert !(legacy.systemd.services.blitzcrank.environment ? BLITZCRANK_CONFIG);
pkgs.runCommand "blitzcrank-module-checks"
  {
    nativeBuildInputs = [ pkgs.jq ];
  }
  ''
    jq -e '
      .web == {
        "apiKey": {"env": "FIRECRAWL_API_KEY"},
        "provider": "firecrawl"
      }
      and .automationModels == {}
      and .media.roots == ["/mnt/structured"]
      and .gateways == [{
        "guildId": "1",
        "id": "default",
        "reportChannelId": "2",
        "token": {"env": "DISCORD_BOT_TOKEN"},
        "type": "discord"
      }]
      and all(..; . != null)
    ' ${generated} >/dev/null
    touch "$out"
  ''
