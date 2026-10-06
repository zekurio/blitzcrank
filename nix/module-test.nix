{ pkgs, package }:

let
  evaluate =
    settings:
    import (pkgs.path + "/nixos/lib/eval-config.nix") {
      inherit pkgs;
      system = pkgs.stdenv.hostPlatform.system;
      modules = [
        ./module.nix
        {
          system.stateVersion = "26.11";
          services.blitzcrank = {
            inherit package;
            enable = true;
          }
          // settings;
        }
      ];
    };
  configured = evaluate {
    model = "openai/test-model:medium";
    authFile = "/var/lib/blitzcrank/custom-auth.json";
    environmentFile = "/run/secrets/blitzcrank.env";
  };
  unconfigured = evaluate { };
  cli = pkgs.lib.findFirst (
    p: p.name == "blitzcrank"
  ) null configured.config.environment.systemPackages;
in
assert !(configured.options.services.blitzcrank.model ? default);
assert
  !(builtins.tryEval unconfigured.config.systemd.services.blitzcrank.environment.BLITZCRANK_MODEL)
  .success;
assert
  configured.config.systemd.services.blitzcrank.environment.BLITZCRANK_AUTH_PATH
  == "/var/lib/blitzcrank/custom-auth.json";
pkgs.runCommand "blitzcrank-module-check" { } ''
  export HOME="$TMPDIR/home"
  export BLITZCRANK_DATA_DIR="$TMPDIR/state"
  mkdir -p "$HOME"

  # Help must not require root or start/stop a service.
  ${cli}/bin/blitzcrank --help
  ${cli}/bin/blitzcrank auth --help

  # The package exposes only the app CLI. Auth works without model/Seerr config.
  test "$(ls ${package}/bin)" = blitzcrank
  ${package}/bin/blitzcrank auth status
  test ! -e "$HOME/.pi"

  # Auth receives the same paths and secret environment file as the service.
  grep -F -- 'BLITZCRANK_AUTH_PATH=/var/lib/blitzcrank/custom-auth.json' ${cli}/bin/blitzcrank
  grep -F -- '--property=EnvironmentFile=/run/secrets/blitzcrank.env' ${cli}/bin/blitzcrank
  touch "$out"
''
