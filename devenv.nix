{ pkgs, ... }:

{
  packages = [
    pkgs.nodejs
    (pkgs.pnpm_11.override { nodejs-slim = pkgs.nodejs; })
    pkgs.ffmpeg-headless
  ];

  dotenv.enable = false;
}
