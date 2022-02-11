import { HelmChartRepositoryConfig } from './config/infrastructure';
import { execCmd } from './utils';

export function helmifyValues(config: any, prefix?: string): string[] {
  if (typeof config !== 'object') {
    return [`--set ${prefix}=${JSON.stringify(config)}`];
  }

  if (config.flatMap) {
    return config.flatMap((value: any, index: number) => {
      return helmifyValues(value, `${prefix}[${index}]`);
    });
  }
  return Object.keys(config).flatMap((key) => {
    const value = config[key];
    return helmifyValues(value, prefix ? `${prefix}.${key}` : key);
  });
}

export async function addHelmRepoIfNotExists(repoConfig: HelmChartRepositoryConfig) {
  const helmRepos = await listHelmRepos();
  // Note this only finds matches based off the name - URL differences are
  // not handled
  for (const existingRepo of helmRepos) {
    if (existingRepo.name === repoConfig.name) {
      if (existingRepo.url !== repoConfig.url) {
        // If for some reason there's a repo with the same name but
        // a different URL, then remove the repo so we can add the new one
        await removeHelmRepo(repoConfig.name);
      } else {
        // There's a match of the name and URL -- nothing to do
        return;
      }
    }
  }
  // If we've gotten here, the repo must be added
  await addHelmRepo(repoConfig);
}

function addHelmRepo(repoConfig: HelmChartRepositoryConfig) {
  return execCmd(`helm repo add ${repoConfig.name} ${repoConfig.url} && helm repo update`);
}

function removeHelmRepo(repoName: string) {
  return execCmd(`helm repo remove ${repoName}`);
}

// Outputs an array of the shape: [{"name":"foo", "url":"bar"}, ...]
async function listHelmRepos() {
  const [output] = await execCmd('helm repo list -o json');
  return JSON.parse(output);
}