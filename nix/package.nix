{
  buildGoModule,
  lib,
  makeWrapper,
  pi,
  rev ? null,
}:

buildGoModule {
  pname = "blitzcrank";
  version = "0.1.0" + lib.optionalString (rev != null) "+${rev}";
  # Explicit allowlist: keeps local state (blitzcrank.toml, *.sqlite*,
  # pi-sessions/, .env*) out of the world-readable Nix store and avoids
  # rebuilds on unrelated file churn.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../cmd
      ../internal
      ../assets.go
      ../go.mod
      ../go.sum
      ../.pi
      ../automations
      ../config.example.toml
      ../README.md
    ];
  };
  vendorHash = "sha256-4+VRp4z8b6jZQKOahOwVqaFTp3MqovzauOREExTHcM8=";
  subPackages = [ "cmd/blitzcrank" ];
  nativeBuildInputs = [ makeWrapper ];
  postInstall = ''
    mkdir -p $out/share/blitzcrank
    cp -R automations .pi $out/share/blitzcrank/
    cp README.md config.example.toml $out/share/blitzcrank/
    printf '%s\n' \
      '[runtime]' \
      "automations_dir = \"$out/share/blitzcrank/automations\"" \
      '[pi]' \
      "cwd = \"$out/share/blitzcrank\"" \
      > $out/share/blitzcrank/config.toml
    wrapProgram $out/bin/blitzcrank \
      --prefix PATH : ${
        lib.makeBinPath [
          pi
        ]
      } \
      --set-default BLITZCRANK_CONFIG $out/share/blitzcrank/config.toml
  '';

  meta = {
    description = "Blitzcrank Seerr automation gateway for Pi";
    homepage = "https://github.com/zekurio/blitzcrank";
    mainProgram = "blitzcrank";
    platforms = lib.platforms.unix;
  };
}
