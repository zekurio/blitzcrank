{
  lib,
  stdenv,
  nodejs_24,
  pnpm_10,
  makeWrapper,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "blitzcrank";
  version = "0.1.0";

  src = lib.cleanSource ../.;

  nativeBuildInputs = [
    nodejs_24
    pnpm_10.configHook
    makeWrapper
  ];

  # Deliberately the pnpm_10-bound fetcher (top-level fetchPnpmDeps binds to
  # pnpm_11, which rejects fetcherVersion 3); hash computed with this pair.
  pnpmDeps = pnpm_10.fetchDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 3;
    hash = "sha256-EQcZBsqXp3pGcQVOhlrKsjDPj77XnCxSosc7j1zwUl8=";
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
    runHook postInstall
  '';

  meta = {
    description = "Agentic webhook gateway for the Seerr/Arr/Jellyfin homelab stack";
    license = lib.licenses.mit;
    mainProgram = "blitzcrank";
    platforms = lib.platforms.linux;
  };
})
