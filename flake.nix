{
  description = "OpenCache – self-hosted Nix binary cache server";

  nixConfig = {
    extra-substituters = [ "https://randymarsh77.github.io/OpenCache/cache" ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          opencache = pkgs.buildNpmPackage {
            pname = "opencache";
            version = "1.0.0";
            src = ./.;

            # Update with: nix build 2>&1 | grep 'got:' | awk '{ print $2 }'
            npmDepsHash = "sha256-IQvqsLGwlf+iz3pbfnkAOtbDkFzcSd1ZrMGrXz2kN5Y=";

            dontNpmBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p $out/lib/opencache $out/bin
              cp -r node_modules $out/lib/opencache/
              cp -r src $out/lib/opencache/
              cp index.js generate-static.js package.json $out/lib/opencache/

              makeWrapper ${pkgs.nodejs}/bin/node $out/bin/opencache \
                --add-flags "$out/lib/opencache/index.js"

              makeWrapper ${pkgs.nodejs}/bin/node $out/bin/opencache-generate-static \
                --add-flags "$out/lib/opencache/generate-static.js"

              runHook postInstall
            '';

            nativeBuildInputs = [ pkgs.makeWrapper ];

            meta = with pkgs.lib; {
              description = "Self-hosted Nix binary cache server";
              license = licenses.mit;
              mainProgram = "opencache";
            };
          };
        in
        {
          default = opencache;
          opencache = opencache;
        }
      );

      devShells = forAllSystems (system:
        let pkgs = pkgsFor system; in
        {
          default = pkgs.mkShell {
            buildInputs = [ pkgs.nodejs ];
          };
        }
      );

      overlays.default = final: prev: {
        opencache = self.packages.${final.system}.default;
      };

      # Helper for consumers to configure their Nix to use an OpenCache instance.
      #
      # Example usage in a NixOS flake:
      #   nix.settings = opencache.lib.substituterConfig {
      #     url = "https://my-cache.pages.dev";
      #     publicKey = "my-cache-1:<base64-public-key>";
      #   };
      lib.substituterConfig = { url, publicKey ? null }: {
        extra-substituters = [ url ];
        extra-trusted-public-keys =
          nixpkgs.lib.optional (publicKey != null) publicKey;
      };
    };
}
