结合https://models.dev/api.json中的数据，生成各大大模型厂商(DeepSeek、通义千问 (Qwen)、MiniMax、Mimo、智谱 GLM、ChatGpt等)的数据数组，数据结构为：
{
    llmCompany: "DeepSeek",
    api_format: "1",  // 根据API_FORMAT_OPTIONS枚举
    url: 'https://api.deepseek.com',
    models: [{
        "model": "deepseek-v4-flash",
        "content_length": "1000000",
        "max_token": "64000",
        "capabilities":["completion","tools","thinking","vision"]
    },{
        "model": "deepseek-v4-pro",
        "content_length": "1000000",
        "max_token": "64000",
        "capabilities":["completion","tools","thinking","vision"]
    }]
}