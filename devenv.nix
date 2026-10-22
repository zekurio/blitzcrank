{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    pnpm = {
      enable = true;
      package = pkgs.pnpm_11.override { nodejs-slim = pkgs.nodejs_24; };
    };
    # TypeScript 7 ships its own language server.
    lsp.enable = false;
  };

  packages = [ pkgs.ffmpeg-headless ];

  # Config is env-only; each package loads its own .env explicitly.
  dotenv.enable = false;
}
