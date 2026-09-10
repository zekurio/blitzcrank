{
  lib,
  stdenv,
  nodejs_26,
  pnpm_11,
  pnpmConfigHook,
  fetchPnpmDeps,
  makeWrapper,
}:
let
  pnpm = pnpm_11.override { nodejs-slim = nodejs_26; };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "blitzcrank";
  version = "0.1.0";

  src = lib.cleanSource ../.;

  nativeBuildInputs = [
    nodejs_26
    pnpm
    pnpmConfigHook
    makeWrapper
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-nRuJjkrFpkaKoJCSD5tOeSy73iLIhkbi0TbeHfME/UQ=";
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
    makeWrapper ${nodejs_26}/bin/node $out/bin/blitzcrank \
      --add-flags "$out/lib/blitzcrank/dist/index.js"
    makeWrapper ${nodejs_26}/bin/node $out/bin/blitz-pi \
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
