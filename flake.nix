{
  description = "Blitzcrank Seerr automation gateway for Pi";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    llm-agents.url = "github:numtide/llm-agents.nix";

  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      llm-agents,
      ...
    }:
    let
      overlays.default = final: prev: {
        # Remove this override (and the buildGoModule/go aliases below) once
        # nixos-unstable ships go >= 1.26; it hand-pins a source hash that
        # otherwise rots.
        go_1_26 = prev.go_1_26.overrideAttrs (_: rec {
          version = "1.26.5";
          src = prev.fetchurl {
            url = "https://go.dev/dl/go${version}.src.tar.gz";
            hash = "sha256-SVvkvIcXasVnOS5bQRar2YRm0z17SdQedkzMaXay3EI=";
          };
        });
        buildGoModule = prev.buildGoModule.override { go = final.go_1_26; };
        go = final.go_1_26;
      };
      nixosModules.default = import ./nix/module.nix { inherit self; };
    in
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ overlays.default ];
        };
        pi = llm-agents.packages.${system}.pi;
      in
      {
        packages = {
          default = pkgs.callPackage ./nix/package.nix {
            inherit pi;
            rev = self.shortRev or self.dirtyShortRev or null;
          };
          pi-coding-agent = pi;
        };

        checks = {
          build = self.packages.${system}.default;
          # Contract check for the Pi CLI/RPC surface Blitzcrank depends on.
          # Mirrors the flags built in internal/pi/runner.go (argsFor) and the
          # seerr-issue run profile's tool list; keep the two in sync. Runs
          # fully offline and only reruns when .pi/ assets or the pinned Pi
          # runtime change. --model is intentionally not exercised: it needs a
          # provider-valid model name, which would make the check fail for the
          # wrong reason.
          pi-contract =
            let
              piAssets = pkgs.lib.fileset.toSource {
                root = ./.;
                fileset = ./.pi;
              };
            in
            pkgs.runCommand "blitzcrank-pi-contract" { nativeBuildInputs = [ pi ]; } ''
              set -euo pipefail
              export HOME="$TMPDIR"
              export PI_OFFLINE=1
              export PI_CODING_AGENT_DIR="$TMPDIR/pi-agent"
              mkdir -p "$PI_CODING_AGENT_DIR"
              cd ${piAssets}

              rpc_get_state() {
                printf '%s\n' '{"type":"get_state"}' | pi --mode rpc "$@"
              }

              # 1. Hermetic smoke: RPC mode answers and the extension loads.
              rpc_get_state --no-session --no-context-files --no-skills \
                --no-prompt-templates --no-extensions \
                --extension .pi/extensions/blitzcrank-tools.ts \
                > "$TMPDIR/minimal.jsonl"
              grep -F '"command":"get_state","success":true' "$TMPDIR/minimal.jsonl" >/dev/null

              # 2. Production flag surface: exactly what runner.go passes for a
              #    seerr issue run (durable session, system prompt, tool list).
              mkdir -p "$TMPDIR/sessions"
              rpc_get_state \
                --system-prompt .pi/system-prompts/seerr-issue.md \
                --no-context-files \
                --extension .pi/extensions/blitzcrank-tools.ts \
                --tools seerr_request,jellyfin_request,sonarr_request,radarr_request,sabnzbd_request,anvil_status,anvil_job_lookup,report_progress,thread_history_search,web_search,web_fetch \
                --session "$TMPDIR/sessions/contract.jsonl" \
                > "$TMPDIR/flags.jsonl"
              grep -F '"command":"get_state","success":true' "$TMPDIR/flags.jsonl" >/dev/null

              touch $out
            '';
        };

        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/blitzcrank";
          meta.description = "Run the Blitzcrank Seerr automation gateway";
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            go
            gopls
            go-tools
            nixfmt
            sqlite
          ];

          # Keep the pinned Pi runtime off PATH so an interactive `pi` uses the
          # user's global installation. Blitzcrank debug runs still inherit the
          # exact Nix runtime through their config env.
          PI_COMMAND = "${pi}/bin/pi";
        };

        formatter = pkgs.writeShellApplication {
          name = "blitzcrank-format";
          runtimeInputs = [ pkgs.nixfmt ];
          text = ''
            if [ "$#" -eq 0 ]; then
              exec nixfmt flake.nix nix/*.nix
            fi
            exec nixfmt "$@"
          '';
        };
      }
    )
    // {
      inherit overlays nixosModules;
    };
}
