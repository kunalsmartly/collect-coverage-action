import * as fs from 'fs/promises';
import assert from 'node:assert';
import { default as libCoverage } from 'istanbul-lib-coverage';
import lcovParser, { SectionSummary } from '@friedemannsommer/lcov-parser';
import { XMLParser } from 'fast-xml-parser';
import { promisify } from 'util';

type Opts = {
  /**
   * Multiply retry backoff by backoffMultiplierMs to get the wait time between retries
   */
  backoffMultiplierMs?: number;
  coverage: string;
  token: string;
  project: string;
  tag: string;
  url: string;
  dryRun?: boolean;
  coverageFormat: 'summary' | 'istanbul' | 'lcov' | 'cobertura';
};

const retryCount = 3;
async function generateSummary(file: string): Promise<libCoverage.CoverageSummary> {
  const map = libCoverage.createCoverageMap({});
  const summary = libCoverage.createCoverageSummary();
  map.merge(
    JSON.parse(await fs.readFile(file, { encoding: 'utf-8' })) as libCoverage.CoverageMapData
  );
  map.files().forEach(file => {
    const fileCoverage = map.fileCoverageFor(file);
    const fileSummary = fileCoverage.toSummary();
    summary.merge(fileSummary);
  });

  return summary;
}

function coverageRecordsToSummary(records: SectionSummary[]): libCoverage.CoverageSummary {
  const flavors = ['branches', 'functions', 'lines'] as const;
  const data: libCoverage.CoverageSummaryData = {
    lines: { total: 0, covered: 0, skipped: 0, pct: 0 },
    statements: { total: 0, covered: 0, skipped: 0, pct: NaN },
    branches: { total: 0, covered: 0, skipped: 0, pct: NaN },
    functions: { total: 0, covered: 0, skipped: 0, pct: NaN }
  };

  for (const file of records) {
    flavors.forEach(flavor => {
      if (file[flavor]) {
        data[flavor].total += file[flavor].instrumented ?? 0;
        data[flavor].covered += file[flavor].hit ?? 0;
      }
    });
  }

  flavors.forEach(flavor => {
    data[flavor].pct =
      data[flavor].total === 0 ? 100 : (data[flavor].covered / data[flavor].total) * 100;
  });
  return libCoverage.createCoverageSummary(data);
}

async function loadLCOV(file: string): Promise<libCoverage.CoverageSummary> {
  return coverageRecordsToSummary(
    await lcovParser({ from: await fs.readFile(file, { encoding: 'utf-8' }) })
  );
}

function assertIsCoberturaReport(data: unknown): asserts data is {
  coverage: {
    '@_lines-valid': string;
    '@_lines-covered': string;
    '@_branches-covered': string;
    '@_branches-valid': string;
    '@_line-rate': string;
    '@_branch-rate': string;
  };
} {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { coverage: unknown }).coverage !== 'object'
  ) {
    throw new Error('Invalid cobertura report');
  }
}

export async function loadCobertura(file: string): Promise<libCoverage.CoverageSummary> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    processEntities: false,
    stopNodes: ['sources', 'packages']
  });
  const report = parser.parse(await fs.readFile(file, { encoding: 'utf-8' })) as unknown;
  assertIsCoberturaReport(report);
  const data: libCoverage.CoverageSummaryData = {
    lines: {
      total: Number(report.coverage['@_lines-valid']),
      covered: Number(report.coverage['@_lines-covered']),
      skipped: 0,
      pct: Number(report.coverage['@_line-rate']) * 100
    },
    statements: { total: 0, covered: 0, skipped: 0, pct: NaN },
    branches: {
      total: Number(report.coverage['@_branches-valid']),
      covered: Number(report.coverage['@_branches-covered']),
      skipped: 0,
      pct: Number(report.coverage['@_branch-rate']) * 100
    },
    functions: { total: 0, covered: 0, skipped: 0, pct: NaN }
  };
  return libCoverage.createCoverageSummary(data);
}

async function loadSummary(file: string): Promise<libCoverage.CoverageSummary> {
  const data = JSON.parse(await fs.readFile(file, { encoding: 'utf-8' })) as {
    total: libCoverage.CoverageSummaryData;
  };
  assert(data.total, `Coverage file '${file}' is not a coverage summary file`);
  const summary = libCoverage.createCoverageSummary();
  // @ts-expect-error data is not a CoverageSummary, but CoverageSummaryData
  summary.merge(data.total);
  return summary;
}

export async function run(opts: Opts) {
  const file = opts.coverage;
  let summary: libCoverage.CoverageSummary;
  if (opts.coverageFormat === 'summary') {
    assert(/\.json$/.test(file), `Coverage file '${file}' should be (jest) json formatted`);
    summary = await loadSummary(file);
  } else if (opts.coverageFormat === 'istanbul') {
    assert(/\.json$/.test(file), `Coverage file '${file}' should be (jest) json formatted`);
    summary = await generateSummary(file);
  } else if (opts.coverageFormat === 'lcov') {
    summary = await loadLCOV(file);
  } else if (opts.coverageFormat === 'cobertura') {
    summary = await loadCobertura(file);
  } else {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    throw new Error(`Unknown coverage format '${opts.coverageFormat}'`);
  }

  await publishCoverage({ ...opts, project: opts.project }, summary);
}

async function publishCoverage(
  opts: Omit<Opts, 'coverage'>,
  coverage: libCoverage.CoverageSummary
) {
  for (const flavor of ['branches', 'statements', 'functions', 'lines'] as const) {
    const pct = coverage[flavor].pct;
    const coveredItems = coverage[flavor].covered;
    const totalItems = coverage[flavor].total;
    
    if (Number.isFinite(pct)) {
      if (opts.token) {
        const data = {
          project: opts.project,
          flavor: flavor,
          value: pct,
          tag: opts.tag,
          covered_items: coveredItems,
          total_items: totalItems
        };
        console.log("Request data is: ",data);
        if (opts.dryRun) {
          console.log(data);
          continue;
        }
        const body = JSON.stringify(data);
        let attempts = 0;
        let done = false;
        while (!done) {
          const response = await fetch(opts.url, {
            method: 'POST',
            body,
            headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' }
          });
          if (response.ok) {
            done = true;
          } else {
            if (attempts++ > retryCount) {
              throw new Error(
                `Failed to publish coverage after ${attempts} attempts: ${response.status} ${response.statusText}`
              );
            }
            await promisify(setTimeout)(Math.pow(attempts, 2) * (opts.backoffMultiplierMs ?? 1000));
          }
        }
      }
    }
  }
}
