<template>
  <div class="chart-row">
    <div class="chart-header">
      <div class="chart-title">{{ title }}</div>
      <el-select v-model="selectedMetric" size="small" class="metric-select">
        <el-option
          v-for="item in metricOptions"
          :key="item.value"
          :label="item.label"
          :value="item.value" />
      </el-select>
    </div>
    <v-chart
      :option="chartOption"
      class="chart-box"
      autoresize />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import type { EChartsOption } from 'echarts'
import type { TokenLineChartProps, TokenMetric, TokenMetricOption } from './index'

const metricOptions: TokenMetricOption[] = [
  { label: '输入用量', value: 'in_token' },
  { label: '输出用量', value: 'out_token' },
  { label: '总token用量', value: 'total_token' },
  { label: '调用次数', value: 'call_count' },
]

const metricNameMap: Record<TokenMetric, string> = {
  in_token: '输入用量',
  out_token: '输出用量',
  total_token: '总token用量',
  call_count: '调用次数',
}

defineOptions({
  name: 'TokenLineChart',
})

// 注册 ECharts 组件
use([CanvasRenderer, LineChart, GridComponent, TooltipComponent])

const props = withDefaults(defineProps<TokenLineChartProps>(), {
  color: '#409EFF',
  empty: false,
  height: 300,
})

const selectedMetric = ref<TokenMetric>('total_token')

const formatDate = (date: Date) => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const getDefaultDateRange = () => {
  const end = new Date()
  const start = new Date()
  start.setDate(end.getDate() - 6)
  return [formatDate(start), formatDate(end)]
}

const getDateList = (range?: string[]) => {
  const [startStr, endStr] = range && range.length === 2 ? range : getDefaultDateRange()
  const dates: string[] = []
  const current = new Date(startStr)
  const end = new Date(endStr)

  while (current <= end) {
    dates.push(formatDate(current))
    current.setDate(current.getDate() + 1)
  }

  return dates
}

// 按日期聚合，支持单模型和全部模型数据；日期范围内没有数据则补 0
const chartData = computed(() => {
  const map = new Map<string, { in_token: number; out_token: number; total_token: number; call_count: number }>()

  for (const item of props.data || []) {
    const exist = map.get(item.stat_date) || { in_token: 0, out_token: 0, total_token: 0, call_count: 0 }
    exist.in_token += item.in_token
    exist.out_token += item.out_token
    exist.total_token += item.total_token
    exist.call_count += item.call_count
    map.set(item.stat_date, exist)
  }

  return getDateList(props.dateRange).map((stat_date) => ({
    stat_date,
    ...(map.get(stat_date) || { in_token: 0, out_token: 0, total_token: 0, call_count: 0 }),
  }))
})

// 生成图表配置
const chartOption = computed<EChartsOption>(() => {
  const metric = selectedMetric.value

  return {
    tooltip: { trigger: 'axis', textStyle: { fontSize: 12 } },
    grid: { left: '3%', right: '4%', bottom: '3%', top: '10%', containLabel: true },
    xAxis: {
      type: 'category',
      data: chartData.value.map((d) => d.stat_date),
      axisLabel: { fontSize: 12 },
    },
    yAxis: {
      type: 'value',
      name: selectedMetric.value === 'call_count' ? '次数' : 'Token',
      nameTextStyle: { fontSize: 12 },
      axisLabel: { fontSize: 12 },
    },
    series: [
      {
        name: metricNameMap[metric],
        type: 'line',
        data: chartData.value.map((d) => d[metric]),
        smooth: true,
        areaStyle: { opacity: 0.15 },
        itemStyle: { color: props.color },
      },
    ],
  }
})

// 当数据变化时，可以触发 ready 事件
watch(
  () => chartOption.value,
  (option) => {
    if (option) {
      // 可选：通知父组件图表已准备好
    }
  },
)
</script>

<style lang="less" scoped>
@import './index.less';
</style>
