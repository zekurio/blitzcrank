{
  description = "Blitzcrank Seerr automation gateway for Pi";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # Pi does not publish a flake. Track the published npm tarball as a raw
    # flake input so packaging can opt into a newer Pi than nixpkgs carries.
    pi-coding-agent-src = {
      url = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.75.4.tgz";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      pi-coding-agent-src,
      ...
    }:
    let
      overlays.default = final: prev: {
        pi-coding-agent = final.callPackage ./nix/pi-coding-agent.nix {
          src = pi-coding-agent-src;
        };
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
      in
      {
        packages = {
          default = pkgs.callPackage ./nix/package.nix { };
          pi-coding-agent = pkgs.pi-coding-agent;
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
