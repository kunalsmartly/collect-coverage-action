import * as core from '@actions/core';
import * as github from '@actions/github';
import * as coverage from './coverage';

const tokenArgument = 'authorization-token';
const coverageFileArgument = 'coverage-file';
const urlArgument = 'url';
const projectNameArgument = 'project-name';

async function run() {
  const pr = github.context.payload.pull_request?.number;
  const coverageFile = core.getInput(coverageFileArgument);
  const projectName = core.getInput(projectNameArgument);
  await coverage.run({
    coverage: coverageFile,
    token: core.getInput(tokenArgument),
    tag: pr != null ? `pr-${pr}` : 'main',
    project: projectName ?? github.context.repo.repo,
    url: core.getInput(urlArgument),
    coverageFormat: (core.getInput('coverage-format') ?? 'istanbul') as 'summary' | 'istanbul',
    dryRun: core.getInput('dry-run') === 'true'
  });
}

void run();
