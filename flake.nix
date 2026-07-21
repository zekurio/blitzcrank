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
          };
          pi-coding-agent = pi;
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
