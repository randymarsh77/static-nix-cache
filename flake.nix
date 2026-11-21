{
  description = "static-nix-cache – self-hosted Nix binary cache server";

  nixConfig = {
    extra-substituters = [ "https://randymarsh77.github.io/static-nix-cache/cache" ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
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
          setup-github = pkgs.writeShellApplication {
            name = "static-nix-cache-setup-github";
            runtimeInputs = [ pkgs.nodejs pkgs.gh pkgs.git pkgs.nix ];
            text = ''
              exec node ${./scripts/setup-github-cache.js} "$@"
            '';
          };
          # op (the 1Password CLI) is unfree, so it is taken from PATH when asked for.
          setup-r2 = pkgs.writeShellApplication {
            name = "static-nix-cache-setup-r2";
            runtimeInputs = [ pkgs.nodejs pkgs.gh pkgs.git pkgs.nix ];
            text = ''
              exec node ${./scripts}/setup-r2-cache.js "$@"
            '';
          };
        }
      );

      apps = forAllSystems (system: {
        setup-github = {
          type = "app";
          program = "${self.packages.${system}.setup-github}/bin/static-nix-cache-setup-github";
          meta.description = "Provision a signed GitHub Releases and Pages cache";
        };
        setup-r2 = {
          type = "app";
          program = "${self.packages.${system}.setup-r2}/bin/static-nix-cache-setup-r2";
          meta.description = "Provision a private, signed Cloudflare R2 cache";
        };
      });

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
