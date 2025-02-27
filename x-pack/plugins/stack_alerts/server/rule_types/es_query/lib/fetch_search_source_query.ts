/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { buildRangeFilter, Filter } from '@kbn/es-query';
import { Logger } from '@kbn/core/server';
import {
  getTime,
  ISearchSource,
  ISearchStartSearchSource,
  SortDirection,
} from '@kbn/data-plugin/common';
import {
  BUCKET_SELECTOR_FIELD,
  buildAggregation,
  isCountAggregation,
  parseAggregationResults,
} from '@kbn/triggers-actions-ui-plugin/common';
import { isGroupAggregation } from '@kbn/triggers-actions-ui-plugin/common';
import { OnlySearchSourceRuleParams } from '../types';
import { getComparatorScript } from '../../../../common';

export interface FetchSearchSourceQueryOpts {
  ruleId: string;
  params: OnlySearchSourceRuleParams;
  latestTimestamp: string | undefined;
  services: {
    searchSourceClient: ISearchStartSearchSource;
    logger: Logger;
  };
  alertLimit?: number;
}

export async function fetchSearchSourceQuery({
  ruleId,
  params,
  latestTimestamp,
  services,
  alertLimit,
}: FetchSearchSourceQueryOpts) {
  const { logger, searchSourceClient } = services;
  const isGroupAgg = isGroupAggregation(params.termField);
  const isCountAgg = isCountAggregation(params.aggType);

  const initialSearchSource = await searchSourceClient.create(params.searchConfiguration);

  const { searchSource, dateStart, dateEnd } = updateSearchSource(
    initialSearchSource,
    params,
    latestTimestamp,
    alertLimit
  );

  logger.debug(
    `search source query rule (${ruleId}) query: ${JSON.stringify(
      searchSource.getSearchRequestBody()
    )}`
  );

  const searchResult = await searchSource.fetch();

  return {
    parsedResults: parseAggregationResults({ isCountAgg, isGroupAgg, esResult: searchResult }),
    dateStart,
    dateEnd,
  };
}

export function updateSearchSource(
  searchSource: ISearchSource,
  params: OnlySearchSourceRuleParams,
  latestTimestamp: string | undefined,
  alertLimit?: number
) {
  const isGroupAgg = isGroupAggregation(params.termField);
  const index = searchSource.getField('index')!;
  const timeFieldName = params.timeField || index.timeFieldName;

  if (!timeFieldName) {
    throw new Error('Invalid data view without timeFieldName.');
  }

  searchSource.setField('size', isGroupAgg ? 0 : params.size);

  const timerangeFilter = getTime(index, {
    from: `now-${params.timeWindowSize}${params.timeWindowUnit}`,
    to: 'now',
  });
  const dateStart = timerangeFilter?.query.range[timeFieldName].gte;
  const dateEnd = timerangeFilter?.query.range[timeFieldName].lte;
  const filters = [timerangeFilter];

  if (params.excludeHitsFromPreviousRun) {
    if (latestTimestamp && latestTimestamp > dateStart) {
      // add additional filter for documents with a timestamp greater then
      // the timestamp of the previous run, so that those documents are not counted twice
      const field = index.fields.find((f) => f.name === timeFieldName);
      const addTimeRangeField = buildRangeFilter(field!, { gt: latestTimestamp }, index);
      filters.push(addTimeRangeField);
    }
  }

  const searchSourceChild = searchSource.createChild();
  searchSourceChild.setField('filter', filters as Filter[]);
  searchSourceChild.setField('sort', [{ [timeFieldName]: SortDirection.desc }]);
  searchSourceChild.setField(
    'aggs',
    buildAggregation({
      aggType: params.aggType,
      aggField: params.aggField,
      termField: params.termField,
      termSize: params.termSize,
      condition: {
        resultLimit: alertLimit,
        conditionScript: getComparatorScript(
          params.thresholdComparator,
          params.threshold,
          BUCKET_SELECTOR_FIELD
        ),
      },
      ...(isGroupAgg ? { topHitsSize: params.size } : {}),
    })
  );
  return {
    searchSource: searchSourceChild,
    dateStart,
    dateEnd,
  };
}
