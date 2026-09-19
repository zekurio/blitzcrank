{
  lib,
  stdenv,
  nodejs,
  pnpm_11,
  pnpmConfigHook,
  fetchPnpmDeps,
  makeWrapper,
}:
let
  pnpm = pnpm_11.override { nodejs-slim = nodejs; };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "blitzcrank";
  version = "0.1.0";

  src = lib.cleanSource ../.;

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
    makeWrapper
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-7JaYx6OkEsW2/SujGmzgm0gB04d09IMAwWVzVd8OZCk=";
  };

  buildPhase = ''
    runHook preBuild
    pnpm build
    pnpm prune --prod --ignore-scripts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/blitzcrank
    cp -r dist node_modules skills automations package.json $out/lib/blitzcrank/
    makeWrapper ${nodejs}/bin/node $out/bin/blitzcrank \
      --add-flags "$out/lib/blitzcrank/dist/index.js"
    makeWrapper ${nodejs}/bin/node $out/bin/blitz-pi \
      --add-flags "$out/lib/blitzcrank/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
    runHook postInstall
  '';

  meta = {
    description = "Agentic webhook gateway for the Seerr/Arr/Jellyfin homelab stack";
    license = lib.licenses.mit;
    mainProgram = "blitzcrank";
    platforms = lib.platforms.linux;
  };
})
