{
  description = "harbor: gauges, charts and the site";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      each = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = each (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [ bun cargo rustc rust-analyzer python3 gdal ];
        };
      });
    };
}
