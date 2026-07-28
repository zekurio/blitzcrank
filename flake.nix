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

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            pnpm
            typescript
          ];

          shellHook = ''
            echo "blitzcrank devshell — node $(node --version), pnpm $(pnpm --version)"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
