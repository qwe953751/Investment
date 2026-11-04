using System.Globalization;
using System.Linq.Expressions;

namespace Invest.Web.Features.Assets.Services;

// 唯一的資產公式定義。C# 執行同一 expression，靜態站與資料庫只使用產生的表示式。
public static class AssetPerformanceFormulas
{
    public static readonly Expression<Func<decimal, decimal, decimal, bool, decimal>> Gain =
        (initial, final, net, adjusted) => final - initial - (adjusted ? net : 0);
    public static readonly Expression<Func<decimal, decimal, decimal>> Add = (left, right) => left + right;
    public static readonly Expression<Func<decimal, decimal, decimal>> Difference = (left, right) => left - right;
    public static readonly Expression<Func<decimal, decimal, decimal, decimal>> Weight =
        (amount, remaining, days) => amount * remaining / days;
    public static readonly Expression<Func<decimal, decimal, decimal?>> Percent =
        (gain, capital) => capital > 0 ? gain / capital * 100 : null;
    public static readonly Expression<Func<decimal, decimal, decimal>> Exchange = (amount, rate) => amount * rate;

    public static readonly Func<decimal, decimal, decimal, bool, decimal> CalculateGain = Gain.Compile();
    public static readonly Func<decimal, decimal, decimal, decimal> CalculateWeight = Weight.Compile();
    public static readonly Func<decimal, decimal, decimal?> CalculatePercent = Percent.Compile();
    public static readonly Func<decimal, decimal, decimal> ConvertCurrency = Exchange.Compile();

    public static string ExchangeSql => $"round({Emit(Exchange.Body, true).Replace("rate", "fx_rate", StringComparison.Ordinal)}, 2)";

    public static string BrowserModule()
    {
        var functions = new (string Name, LambdaExpression Formula)[] {
            ("gain", Gain), ("add", Add), ("difference", Difference), ("weight", Weight), ("percent", Percent), ("exchange", Exchange) };
        return "// Generated from AssetPerformanceFormulas.cs; do not hand-edit financial formulas.\n"
            + "globalThis.AssetPerformance = (() => {\n"
            + string.Join('\n', functions.Select(f => $"const {f.Name}=({string.Join(',', f.Formula.Parameters.Select(p => p.Name))})=>{Emit(f.Formula.Body, false)};"))
            + "\n" + BrowserPipeline + "\n})();\n";
    }

    private static string Emit(Expression expression, bool sql) => expression switch {
        ParameterExpression parameter => parameter.Name!,
        ConstantExpression constant => constant.Value is null ? "null" : Convert.ToString(constant.Value, CultureInfo.InvariantCulture)!,
        UnaryExpression unary when unary.NodeType == ExpressionType.Convert => Emit(unary.Operand, sql),
        ConditionalExpression conditional => sql
            ? $"(case when {Emit(conditional.Test, true)} then {Emit(conditional.IfTrue, true)} else {Emit(conditional.IfFalse, true)} end)"
            : $"({Emit(conditional.Test, false)}?{Emit(conditional.IfTrue, false)}:{Emit(conditional.IfFalse, false)})",
        BinaryExpression binary => $"({Emit(binary.Left, sql)}{Operator(binary.NodeType)}{Emit(binary.Right, sql)})",
        _ => throw new NotSupportedException($"資產公式不支援的表示式：{expression.NodeType}")
    };

    private static string Operator(ExpressionType type) => type switch {
        ExpressionType.Add => "+", ExpressionType.Subtract => "-", ExpressionType.Multiply => "*",
        ExpressionType.Divide => "/", ExpressionType.GreaterThan => ">",
        _ => throw new NotSupportedException($"資產公式不支援的運算：{type}")
    };

    // 只做日期篩選、完整性檢查及資料編排；所有金額／百分比運算呼叫上方產生的公式。
    private const string BrowserPipeline = """
    const sum=values=>values.reduce((total,value)=>add(total,value),0);
    const day=value=>Date.parse(value+'T00:00:00Z')/86400000;
    function calculate(request){
      const rates=(request.rates??[]).filter(r=>r.value>0).sort((a,b)=>a.date.localeCompare(b.date));
      const flows=request.flows.map(f=>({...f,amount:f.valued?f.amountTwd:f.currency==='USD'
        ?(f.amount==null||!rates.some(r=>r.date<=f.date)?null:exchange(f.amount,rates.filter(r=>r.date<=f.date).at(-1).value)):f.amount}));
      return request.windows.map(w=>{
        const missing=reason=>({gain:null,percent:null,netFlow:null,reason,assetValue:null});
        if(w.initial==null||w.final==null||w.end<w.start)return missing('缺少完整的期初／期末估值');
        const selected=flows.filter(f=>f.date>w.start&&f.date<=w.end);
        if(request.adjusted&&(!request.available||selected.some(f=>f.amount==null)))return missing('出入金資料或該日歷史匯率不足');
        const net=sum(selected.map(f=>f.amount??0));
        if(request.adjusted&&w.initial===0&&w.final>0&&!selected.some(f=>f.amount>0))
          return {...missing('期初為零且沒有入金紀錄，無法區分投入與獲利'),netFlow:net};
        const result=gain(w.initial,w.final,net,request.adjusted),days=difference(day(w.end),day(w.start));
        const capital=request.adjusted&&days>0?add(w.initial,sum(selected.map(f=>weight(f.amount??0,difference(day(w.end),day(f.date)),days)))):w.initial;
        return {gain:result,percent:percent(result,capital),netFlow:net,
          reason:capital<=0?'計算基準資金不大於零，無可用報酬率':null,assetValue:add(w.initial,result)};
      });
    }
    function funding(flows,asOf,year=null,available=true){
      const selected=flows.filter(f=>f.date<=asOf&&(year==null||Number(f.date.slice(0,4))===Number(year)));
      return {nativeNet:available&&selected.every(f=>f.amount!=null)&&new Set(selected.map(f=>f.currency)).size<=1?sum(selected.map(f=>f.amount)):null,
        twdNet:available&&selected.every(f=>f.amountTwd!=null)?sum(selected.map(f=>f.amountTwd)):null};
    }
    return {calculate,funding,difference,exchange,sum};
    """;
}
