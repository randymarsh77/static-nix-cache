import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

const FeatureList = [
  {
    title: 'Zero Cost',
    description: (
      <>
        Store NAR files as GitHub Release assets and serve narinfo via GitHub
        Pages. No servers, no cloud storage bills.
      </>
    ),
  },
  {
    title: 'Drop-in GitHub Action',
    description: (
      <>
        Add a single workflow step to cache your Nix build outputs.
        Supports matrix builds with save, restore, and deploy actions.
      </>
    ),
  },
  {
    title: 'Static & Portable',
    description: (
      <>
        Generate a static site deployable to GitHub Pages, Cloudflare Pages,
        Netlify, or any static host. No runtime server required.
      </>
    ),
  },
];

function Feature({title, description}) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
