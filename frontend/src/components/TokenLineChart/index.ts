import type { TokenStat } from '@/api/tokenStatsService';
import type { EChartsOption } from 'echarts';

export interface TokenLineChartProps {
  /** 标题 */
  title: string;
  /** 统计数据 */
  data: TokenStat[];
  /** 图表颜色 */
  color?: string;
  /** 是否显示为空状态 */
  empty?: boolean;
  /** 图表高度 */
  height?: number | string;
  /** 日期范围 [start, end]，用于补零 */
  dateRange?: string[];
}

export type TokenMetric = 'in_token' | 'out_token' | 'total_token' | 'call_count';

export interface TokenMetricOption {
  label: string;
  value: TokenMetric;
}

export type ChartType = 'single' | 'all';

export interface SingleModelChartEmits {
  (e: 'ready', option: EChartsOption): void;
}
