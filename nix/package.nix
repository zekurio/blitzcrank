{
  buildGoModule,
  lib,
  makeWrapper,
  firecrawlPi,
  pi,
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
      base != ".git" && base != ".direnv" && base != ".env" && base != "git" && base != "result";
  };
  vendorHash = "sha256-4+VRp4z8b6jZQKOahOwVqaFTp3MqovzauOREExTHcM8=";
  subPackages = [ "cmd/blitzcrank" ];
  nativeBuildInputs = [ makeWrapper ];
  nativeCheckInputs = [ pi ];
  postCheck = ''
    mkdir -p "$TMPDIR/pi-agent"
    response="$TMPDIR/pi-extension-smoke.jsonl"
    printf '%s\n' '{"type":"get_state"}' \
      | PI_OFFLINE=1 PI_CODING_AGENT_DIR="$TMPDIR/pi-agent" \
        pi --mode rpc --no-session --no-context-files --no-skills \
          --no-prompt-templates --no-extensions \
          --extension .pi/extensions/blitzcrank-tools.ts \
          --extension ${firecrawlPi}/lib/pi-firecrawl \
      > "$response"
    grep -F '"command":"get_state","success":true' "$response" >/dev/null
  '';
  postInstall = ''
    mkdir -p $out/share/blitzcrank
    cp -R automations .pi $out/share/blitzcrank/
    rm -f $out/share/blitzcrank/.pi/settings.json
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
      --set PI_FIRECRAWL_EXTENSION ${firecrawlPi}/lib/pi-firecrawl \
      --set-default BLITZCRANK_CONFIG $out/share/blitzcrank/config.toml
  '';
}
