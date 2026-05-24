{
  buildGoModule,
  lib,
  makeWrapper,
  pi-coding-agent,
}:

buildGoModule {
  pname = "blitzcrank";
  version = "0.1.0";
  src = builtins.path {
    path = ../.;
    name = "blitzcrank-source";
    filter =
      path: type:
      let
        base = baseNameOf path;
      in
      base != ".git" && base != ".direnv" && base != ".env" && base != "result";
  };
  vendorHash = "sha256-NWmrgKrWlgeu0So3kvkunty5EmPNHfe8MffZbvIoskk=";
  subPackages = [ "cmd/blitzcrank" ];
  nativeBuildInputs = [ makeWrapper ];
  postInstall = ''
    mkdir -p $out/share/blitzcrank
    cp -R automations .pi $out/share/blitzcrank/
    printf '%s\n' \
      '[runtime]' \
      "automations_dir = \"$out/share/blitzcrank/automations\"" \
      '[pi]' \
      "cwd = \"$out/share/blitzcrank\"" \
      > $out/share/blitzcrank/config.toml
    wrapProgram $out/bin/blitzcrank \
      --prefix PATH : ${
        lib.makeBinPath [
          pi-coding-agent
        ]
      } \
      --set-default BLITZCRANK_CONFIG $out/share/blitzcrank/config.toml
  '';
}
