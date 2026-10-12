{
  lib,
  stdenv,
  nodejs,
  pnpm_11,
  pnpmConfigHook,
  fetchPnpmDeps,
  makeWrapper,
  component ? "host",
}:
let
  pnpm = pnpm_11.override { nodejs-slim = nodejs; };
  isHost = component == "host";
  pname = if isHost then "blitzcrank" else "blitzcrank-mcp";
  workspace = if isHost then "blitzcrank" else "@blitzcrank/mcp";
in
assert builtins.elem component [
  "host"
  "mcp"
];
stdenv.mkDerivation (finalAttrs: {
  inherit pname;
  version = "0.1.0";

  src = lib.cleanSource ../.;

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
    makeWrapper
  ];

  pnpmDeps = fetchPnpmDeps {
    # Both builds use the same locked workspace dependency store.
    pname = "blitzcrank";
    inherit (finalAttrs) version src;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-LxUIpq1T8jigu3ilEAIzRXClPf8i4UAcvJemofYVFNs=";
  };

  buildPhase = ''
    runHook preBuild
    pnpm --filter ${lib.escapeShellArg workspace} build
    # Each output needs its own dependency tree, with no links back into the
    # workspace. Enable pnpm 11's locked deployment path for this command;
    # neither package has workspace dependencies that would need injection.
    pnpm --filter ${lib.escapeShellArg workspace} \
      --config.inject-workspace-packages=true deploy \
      --prod --offline --ignore-scripts "$TMPDIR/deploy"
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    root=$out/lib/${pname}
    mkdir -p "$root"
    cp -r "$TMPDIR/deploy/node_modules" "$root/"
    cp -r packages/${component}/{dist,package.json} "$root/"
    ${lib.optionalString isHost ''cp -r packages/host/skills "$root/"''}
    # pnpm's install state records the build directory and a timestamp.
    rm -f $root/node_modules/{.modules.yaml,.pnpm-workspace-state-v1.json}
    makeWrapper ${nodejs}/bin/node $out/bin/${pname} \
      --add-flags "$root/dist/cli.js"
    runHook postInstall
  '';

  meta = {
    description =
      if isHost then
        "Agentic webhook gateway for the Seerr/Arr/Jellyfin homelab stack"
      else
        "MCP server for the Seerr/Arr/Jellyfin homelab stack";
    license = lib.licenses.mit;
    mainProgram = pname;
    platforms = lib.platforms.linux;
  };
})
