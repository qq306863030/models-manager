export default class BaseProxy {
  // 输入数据优化
  private optimizeInputData(input: any) {}
  // proxy代理
  private proxy(input: any) {}
  // 输出数据优化
  private optimizeOutputData(input: any) {}
  public async convert(input: any): Promise<any> {
    input = this.optimizeInputData(input)
    input = await this.proxy(input)
    const output = this.optimizeOutputData(input)
    return output
  }
}
