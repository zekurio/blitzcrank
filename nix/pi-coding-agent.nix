{
  buildNpmPackage,
  cairo,
  giflib,
  lib,
  libjpeg,
  librsvg,
  makeWrapper,
  nodejs,
  pango,
  pixman,
  pkg-config,
  python3,
  src,
}:

buildNpmPackage rec {
  pname = "pi-coding-agent";
  version = "0.75.4";
  inherit src;

  npmDepsHash = "sha256-BCGlQI7aYv4RriXF1r8ulAuoAtrod5SVwyZwNFYAzlk=";

  postPatch = ''
    ${nodejs}/bin/node <<'EOF'
    const fs = require("fs");
    const pkgPath = "package.json";
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    delete pkg.devDependencies;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    const path = "npm-shrinkwrap.json";
    const lock = JSON.parse(fs.readFileSync(path, "utf8"));
    const integrities = {
      "node_modules/@earendil-works/pi-agent-core": "sha512-cGYbysb4EqUf0B28OeqFq2ppm1XF3bYBOP71q9dv38yf/UJfzMjiXBeNelrcio+QWIoVrW+xzYm7sMzYIUc9Og==",
      "node_modules/@earendil-works/pi-ai": "sha512-m/w8Hh3vQ0rAycwJiJWdzkypkn4295f4eq/966lDRy8aX5sk6bgYXH8TQmL16TO7Uwc7MbJG0QoyFHgX8RqXUQ==",
      "node_modules/@earendil-works/pi-tui": "sha512-PDhKU7u6fmEcvHUFHzrRwGc/Ytokj/hO+X4RPf+MWKEGpvg3B1vHv88Ee+Dy33004tYkQF5YeXV4btJZcp5x1g==",
    };
    for (const [pkgPath, integrity] of Object.entries(integrities)) {
      lock.packages[pkgPath].integrity = integrity;
    }
    fs.writeFileSync(path, JSON.stringify(lock, null, 2) + "\n");
    EOF
  '';

  dontNpmBuild = true;
  npmInstallFlags = [ "--omit=dev" ];

  nativeBuildInputs = [
    makeWrapper
    pkg-config
    python3
  ];

  buildInputs = [
    cairo
    giflib
    libjpeg
    librsvg
    pango
    pixman
  ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/node_modules/pi
    cp -R . $out/lib/node_modules/pi/

    mkdir -p $out/bin
    makeWrapper ${nodejs}/bin/node $out/bin/pi \
      --add-flags $out/lib/node_modules/pi/dist/cli.js \
      --set NODE_PATH $out/lib/node_modules/pi/node_modules

    runHook postInstall
  '';

  meta = {
    description = "Pi coding agent";
    homepage = "https://github.com/earendil-works/pi-mono";
    license = lib.licenses.mit;
    mainProgram = "pi";
  };
}
