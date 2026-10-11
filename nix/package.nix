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
    hash = "sha256-LxUIpq1T8jigu3ilEAIzRXClPf8i4UAcvJemofYVFNs=";
  };

  buildPhase = ''
    runHook preBuild
    pnpm build
    # `pnpm prune --prod` cannot prune a workspace in place: it asks to purge
    # node_modules and aborts without a TTY. Reinstall the production
    # dependencies from the offline store instead.
    rm -rf node_modules packages/*/node_modules
    pnpm install --offline --prod --frozen-lockfile --ignore-scripts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    root=$out/lib/blitzcrank
    mkdir -p $root/packages/host $root/packages/mcp
    # The workspace layout is kept as-is: packages/*/node_modules hold
    # relative symlinks into the root node_modules/.pnpm, and the host reads
    # skills from its own package root.
    cp -r node_modules package.json pnpm-workspace.yaml $root/
    cp -r packages/host/{dist,node_modules,skills,package.json} $root/packages/host/
    cp -r packages/mcp/{dist,node_modules,package.json} $root/packages/mcp/
    # pnpm's install state records the build directory and a timestamp.
    rm -f $root/node_modules/{.modules.yaml,.pnpm-workspace-state-v1.json}
    makeWrapper ${nodejs}/bin/node $out/bin/blitzcrank \
      --add-flags "$root/packages/host/dist/cli.js"
    makeWrapper ${nodejs}/bin/node $out/bin/blitzcrank-mcp \
      --add-flags "$root/packages/mcp/dist/cli.js"
    runHook postInstall
  '';

  meta = {
    description = "Agentic webhook gateway for the Seerr/Arr/Jellyfin homelab stack";
    license = lib.licenses.mit;
    mainProgram = "blitzcrank";
    platforms = lib.platforms.linux;
  };
})
