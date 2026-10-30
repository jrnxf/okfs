{
  description = "okfs - a web file browser";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      cargoToml = fromTOML (builtins.readFile ./Cargo.toml);
    in
    {
      packages = forAllSystems (pkgs: {
        default =
          let
            # The page's dependencies, installed from ui/bun.lock. A build has no network, so this
            # is a fixed-output derivation: it may fetch, but only if the result matches the hash.
            # Optional packages are left out: they are the per-platform compiler binaries of
            # typescript, which the build does not use, and leaving them out keeps the hash the
            # same on every system.
            #
            # After ui/bun.lock changes, set the hash to `pkgs.lib.fakeHash`, run `nix build`, and
            # copy the hash it reports for this derivation.
            uiModules = pkgs.stdenvNoCC.mkDerivation {
              pname = "okfs-ui-modules";
              inherit (cargoToml.package) version;
              src = pkgs.lib.fileset.toSource {
                root = ./ui;
                fileset = pkgs.lib.fileset.unions [
                  ./ui/package.json
                  ./ui/bun.lock
                ];
              };
              nativeBuildInputs = [ pkgs.bun ];
              dontConfigure = true;
              dontFixup = true;
              buildPhase = ''
                bun install --frozen-lockfile --omit=optional --ignore-scripts --no-progress
              '';
              installPhase = ''
                cp -r node_modules $out
              '';
              outputHashMode = "recursive";
              outputHashAlgo = "sha256";
              outputHash = "sha256-TlKBMvg7wHIj6GXfsX4mNExPXQVQFUD674ei8T/b4t4=";
            };
          in
          pkgs.rustPlatform.buildRustPackage {
            pname = cargoToml.package.name;
            inherit (cargoToml.package) version;

            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./Cargo.toml
                ./Cargo.lock
                ./THIRD_PARTY.md
                ./build.rs
                ./src
                ./themes
                ./ui
              ];
            };
            cargoLock.lockFile = ./Cargo.lock;

            nativeBuildInputs = [ pkgs.bun ];

            # build.rs would run `bun install`, which needs the network. Build the page here from
            # the modules above and have build.rs embed it as it is.
            preBuild = ''
              cp -r --no-preserve=mode ${uiModules} ui/node_modules
              (cd ui && bun run build)
              export OKFS_SKIP_UI_BUILD=1
            '';

            # The workflow in .github/workflows runs the tests.
            doCheck = false;

            meta = {
              inherit (cargoToml.package) description;
              homepage = "https://github.com/jrnxf/okfs";
              license = pkgs.lib.licenses.mit;
              mainProgram = cargoToml.package.name;
            };
          };
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = pkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
          meta.description = cargoToml.package.description;
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            cargo
            rustc
            clippy
            rustfmt
            rust-analyzer
            bun
          ];
          RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";
        };
      });
    };
}
