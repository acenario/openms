// List PUSH-immediate consumers of decoded string-pool IDs (see clientStrings.java) and decompile them.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.scalar.Scalar;
import java.io.*;
import java.util.*;
public class stringIdRefs extends GhidraScript {
 public void run() throws Exception {
  String[] a=getScriptArgs();PrintWriter o=new PrintWriter(a[0]);Set<Long> ids=new HashSet<>();Set<Function> fs=new LinkedHashSet<>();
  for(String s:a[1].split(","))ids.add(Long.decode(s));
  InstructionIterator is=currentProgram.getListing().getInstructions(true);
  while(is.hasNext()){Instruction i=is.next();if(!i.getMnemonicString().equals("PUSH"))continue;Scalar v=i.getScalar(0);if(v==null||!ids.contains(v.getUnsignedValue()))continue;Function f=getFunctionContaining(i.getAddress());o.println("ID_XREF 0x"+Long.toHexString(v.getUnsignedValue())+" INS "+i.getAddress()+" FUNCTION "+(f==null?"NONE":f.getEntryPoint()));if(f!=null)fs.add(f);}
  DecompInterface d=new DecompInterface();d.openProgram(currentProgram);
  for(Function f:fs){DecompileResults r=d.decompileFunction(f,120,monitor);o.println("FUNCTION "+f.getEntryPoint());o.println(r.decompileCompleted()?r.getDecompiledFunction().getC():r.getErrorMessage());}
  d.dispose();o.close();
 }
}
