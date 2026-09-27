using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;
class JobRunner {
 [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {public int cb;public string reserved,desktop,title;public int x,y,xSize,ySize,xChars,yChars,fill,flags;public short show,reserved2;public IntPtr reservedPtr,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {public IntPtr process,thread;public int pid,tid;}
 [StructLayout(LayoutKind.Sequential)] struct BASIC {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong r,w,o,rb,wb,ob;}
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED {public BASIC basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attr,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref EXTENDED info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
 [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 static string Quote(string s){var b=new StringBuilder("\"");int slash=0;foreach(char c in s){if(c=='\\'){slash++;continue;}if(c=='"'){b.Append('\\',slash*2+1);b.Append(c);}else{b.Append('\\',slash);b.Append(c);}slash=0;}b.Append('\\',slash*2);return b.Append('"').ToString();}
 static int Main(string[] args){
  if(args.Length<2)return 125;
  IntPtr job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)return 125;
  var limits=new EXTENDED();limits.basic.flags=0x2000;
  if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED))))return 125;
  try {
   var owner=Process.GetProcessById(int.Parse(args[0]));
   var monitor=new Thread(()=>{try{owner.WaitForExit();}catch{}Environment.Exit(124);});monitor.IsBackground=true;monitor.Start();
   var cmd=new StringBuilder();for(int i=1;i<args.Length;i++){if(i>1)cmd.Append(' ');cmd.Append(Quote(args[i]));}
   var si=new STARTUPINFO();si.cb=Marshal.SizeOf(typeof(STARTUPINFO));si.flags=0x100;si.input=GetStdHandle(-10);si.output=GetStdHandle(-11);si.error=GetStdHandle(-12);
   SetHandleInformation(si.input,1,1);SetHandleInformation(si.output,1,1);SetHandleInformation(si.error,1,1);
   PROCESS_INFORMATION pi;
   if(!CreateProcess(args[1],cmd,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref si,out pi)){Console.Error.WriteLine("Trio CreateProcess: "+Marshal.GetLastWin32Error());return 125;}
   if(!AssignProcessToJobObject(job,pi.process)){TerminateProcess(pi.process,125);Console.Error.WriteLine("Trio AssignProcessToJobObject failed");return 125;}
   ResumeThread(pi.thread);CloseHandle(pi.thread);WaitForSingleObject(pi.process,0xffffffff);uint code;GetExitCodeProcess(pi.process,out code);CloseHandle(pi.process);return (int)code;
  }catch(Exception e){Console.Error.WriteLine("Trio JobRunner: "+e.Message);return 125;}finally{CloseHandle(job);}
 }
}
