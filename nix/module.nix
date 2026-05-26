{ self }:

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
    bot = {
      public_name = cfg.publicName;
    };
    discord = {
      automation_channel_id = cfg.discordAutomationChannelId;
    };
    storage = {
      database_path = toString cfg.databasePath;
      cache_dir = "${cfg.dataDir}/cache";
    };
    runtime = {
      automations_dir = cfg.automationsDir;
      automations_enabled = cfg.automations.enable;
      automations_extra_dirs = cfg.extraAutomationDirs;
      timezone = cfg.timezone;
    };
    pi = {
      command = cfg.piCommand;
      cwd = cfg.piCwd;
      agent_dir = cfg.piAgentDir;
      sessions_dir = "${cfg.dataDir}/pi-sessions";
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
    enable = lib.mkEnableOption "Blitzcrank Seerr automation agent";
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
      default = "blitzcrank";
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
      default = "${self.packages.${pkgs.system}.pi-coding-agent}/bin/pi";
    };
    piCwd = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.package}/share/blitzcrank";
    };
    piAgentDir = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.dataDir}/pi-agent";
      description = "Pi config/auth directory. Seed with auth.json/settings.json or run Pi login as the service user.";
    };
    piModels = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Per-task Pi model map. Keys include default, seerr, and automation. Include thinking inline, for example anthropic/claude-sonnet-4-5:high.";
    };
    discordAutomationChannelId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Discord channel id for automation run threads and /automatisierung reporting.";
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
      "d ${cfg.dataDir}/cache 0750 ${cfg.user} ${cfg.group} - -"
    ];
    systemd.services.blitzcrank = {
      description = "Blitzcrank Seerr automation agent";
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
}
