{
  description = "static-nix-cache – self-hosted Nix binary cache server";

  nixConfig = {
    extra-substituters = [ "https://randymarsh77.github.io/static-nix-cache/cache" ];
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
          staticNixCache = pkgs.buildNpmPackage {
            pname = "static-nix-cache";
            version = "1.0.0";
            src = ./.;

            # Update with: nix build 2>&1 | grep 'got:' | awk '{ print $2 }'
            npmDepsHash = "sha256-sBVsVaV5ywOf4f9ewMNouslaqW8Lmba7Yr/3xW/v6tI=";

            dontNpmBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p $out/lib/static-nix-cache $out/bin
              cp -r node_modules $out/lib/static-nix-cache/
              cp -r src $out/lib/static-nix-cache/
              cp index.js generate-static.js package.json $out/lib/static-nix-cache/

              makeWrapper ${pkgs.nodejs}/bin/node $out/bin/static-nix-cache \
                --add-flags "$out/lib/static-nix-cache/index.js"

              makeWrapper ${pkgs.nodejs}/bin/node $out/bin/static-nix-cache-generate-static \
                --add-flags "$out/lib/static-nix-cache/generate-static.js"

              runHook postInstall
            '';

            nativeBuildInputs = [ pkgs.makeWrapper ];

            meta = with pkgs.lib; {
              description = "Self-hosted Nix binary cache server";
              license = licenses.mit;
              mainProgram = "static-nix-cache";
            };
          };
        in
        {
          default = staticNixCache;
          "static-nix-cache" = staticNixCache;
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
        "static-nix-cache" = self.packages.${final.system}.default;
      };

      # Helper for consumers to configure their Nix to use a static-nix-cache instance.
      #
      # Example usage in a NixOS flake:
      #   nix.settings = inputs."static-nix-cache".lib.substituterConfig {
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
