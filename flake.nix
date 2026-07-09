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
      overlays.default = final: prev: { };
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
          default = pkgs.callPackage ./nix/package.nix {
            pi = llm-agents.packages.${system}.pi;
          };
          pi-coding-agent = llm-agents.packages.${system}.pi;
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
