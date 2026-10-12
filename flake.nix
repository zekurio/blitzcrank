{
  description = "blitzcrank - agentic webhook gateway for the Seerr/Arr/Jellyfin homelab stack";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      # x86_64-darwin is gone from nixpkgs 26.11.
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
        blitzcrank-mcp = pkgs.callPackage ./nix/package.nix { component = "mcp"; };
        default = blitzcrank;
      });

      # `nix flake check` builds both packages on linux CI.
      checks = forSystems linuxSystems (pkgs: {
        blitzcrank = self.packages.${pkgs.stdenv.hostPlatform.system}.blitzcrank;
        blitzcrank-mcp = self.packages.${pkgs.stdenv.hostPlatform.system}.blitzcrank-mcp;
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
        blitzcrank-mcp =
          { pkgs, lib, ... }:
          {
            imports = [ ./nix/mcp-module.nix ];
            services.blitzcrank-mcp.package = lib.mkDefault (
              self.packages.${pkgs.stdenv.hostPlatform.system}.blitzcrank-mcp
            );
          };
        default = {
          imports = [
            blitzcrank
            blitzcrank-mcp
          ];
        };
      };

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
