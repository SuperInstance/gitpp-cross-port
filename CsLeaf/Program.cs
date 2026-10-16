using System; using System.IO; using System.Text.Json; using System.Threading.Tasks; using Gitpp;
class Program {
  static async Task Main() {
    var json = await Console.In.ReadToEndAsync();
    foreach (var r in Gitpp.Numbers.ParseRecords(json)) Console.WriteLine(Fold.RecordLeaf(r));
  }
}
