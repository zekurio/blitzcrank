{
  lib,
  stdenv,
  nodejs_24,
  pnpm_10,
  pnpmConfigHook,
  fetchPnpmDeps,
  makeWrapper,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "blitzcrank";
  version = "0.1.0";

  src = lib.cleanSource ../.;

  nativeBuildInputs = [
    nodejs_24
    pnpm_10
    pnpmConfigHook
    makeWrapper
  ];

  # Keep pnpm 10: the default pnpm 11 rejects fetcherVersion 3.
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 3;
    hash = "sha256-Z03TfBzjmmnkSsjRSWl/84jZcEZeAYkGjc9Ld6GKPGs=";
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
    makeWrapper ${nodejs_24}/bin/node $out/bin/blitzcrank \
      --add-flags "$out/lib/blitzcrank/dist/index.js"
    makeWrapper ${nodejs_24}/bin/node $out/bin/blitz-pi \
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
