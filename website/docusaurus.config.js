// @ts-check
import {themes as prismThemes} from 'prism-react-renderer';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'OpenCache',
  tagline: 'Deploy a Nix binary cache for your project. For free.',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://randymarsh77.github.io',
  baseUrl: '/OpenCache/',

  organizationName: 'randymarsh77',
  projectName: 'OpenCache',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: '../docs',
          sidebarPath: './sidebars.js',
          editUrl:
            'https://github.com/randymarsh77/OpenCache/edit/master/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'OpenCache',
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docsSidebar',
            position: 'left',
            label: 'Docs',
          },
          {
            href: 'https://github.com/randymarsh77/OpenCache',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              {
                label: 'Getting Started',
                to: '/docs/getting-started',
              },
              {
                label: 'Configuration',
                to: '/docs/configuration',
              },
              {
                label: 'GitHub Actions',
                to: '/docs/github-actions',
              },
            ],
          },
          {
            title: 'More',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/randymarsh77/OpenCache',
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} OpenCache. Built with Docusaurus.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['nix', 'bash', 'ini'],
      },
    }),
};

export default config;
