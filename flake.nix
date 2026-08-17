{
  description = "blitzcrank - agentic webhook gateway for the Seerr/Arr/Jellyfin homelab stack";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      # x86_64-darwin is gone from nixpkgs 26.11; aarch64-darwin is dev-only.
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      linuxSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forSystems = list: f: nixpkgs.lib.genAttrs list (system: f nixpkgs.legacyPackages.${system});
      forAllSystems = forSystems systems;
    in
    {
      # The service is deployed on NixOS only; no darwin packages.
      packages = forSystems linuxSystems (pkgs: rec {
        blitzcrank = pkgs.callPackage ./nix/package.nix { };
        default = blitzcrank;
      });

      # `nix flake check` builds the package on linux CI.
      checks = forSystems linuxSystems (pkgs: {
        blitzcrank = pkgs.callPackage ./nix/package.nix { };
      });

      nixosModules = rec {
        blitzcrank =
          { pkgs, lib, ... }:
          {
            imports = [ ./nix/module.nix ];
            services.blitzcrank.package = lib.mkDefault (
              self.packages.${pkgs.stdenv.hostPlatform.system}.blitzcrank
            );
          };
        default = blitzcrank;
      };

      devShells = forAllSystems (
        pkgs:
        let
          blitzPi = pkgs.writeShellApplication {
            name = "blitz-pi";
            runtimeInputs = [
              pkgs.git
              pkgs.nodejs_24
            ];
            text = ''
              root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
                echo "blitz-pi must be run inside the blitzcrank checkout" >&2
                exit 1
              }
              cli="$root/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
              if [ ! -f "$cli" ]; then
                echo "blitz-pi requires pnpm install in $root" >&2
                exit 1
              fi
              exec node "$cli" "$@"
            '';
          };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              blitzPi
              nodejs_24
              pnpm
              typescript
            ];

            shellHook = ''
              echo "blitzcrank devshell — node $(node --version), pnpm $(pnpm --version), blitz-pi available"
            '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
