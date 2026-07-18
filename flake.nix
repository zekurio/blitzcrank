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
        firecrawlPi = pkgs.buildNpmPackage {
          pname = "pi-firecrawl";
          version = "0.1.0-2026-05-20";

          src = pkgs.fetchFromGitHub {
            owner = "firecrawl";
            repo = "pi-firecrawl";
            rev = "2d7e8966ad63744fa7d5932f7bd5b4a78eddb894";
            hash = "sha256-1jbWRlQh72qoGUf2Bl220ZGKVzH/AsDgrS9weGgxb2I=";
          };

          npmDepsHash = "sha256-+ox5eIPBF9eY0yPw5IL4LypRSxZ1sz8JCFaDjmZ2DuU=";
          dontNpmBuild = true;

          installPhase = ''
            runHook preInstall
            mkdir -p "$out/lib/pi-firecrawl"
            cp -R src package.json node_modules "$out/lib/pi-firecrawl/"
            runHook postInstall
          '';
        };
      in
      {
        packages = {
          default = pkgs.callPackage ./nix/package.nix {
            inherit firecrawlPi;
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
