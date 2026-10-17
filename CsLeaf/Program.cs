using System;
using System.IO;
using System.Text;
using System.Text.Json;
using Gitpp;

class Program {
  static async Task Main() {
    var json = await Console.In.ReadToEndAsync();
    var records = Gitpp.Numbers.ParseRecords(json);
    var sb = new StringBuilder();
    foreach (var r in records) sb.AppendLine(Fold.RecordLeaf(r));
    Console.Write(sb.ToString());
  }
}
